# Operations runbook — backup, monitoring, alerts aur rollback

Ye Point 5 (production operations) aur Point 4 (rollback) ka runbook hai. Code local par tested hai; VPS par setup aur live alert delivery abhi verify karni hai.

## Kya bana hai

| Kaam           | Kab chalta hai                            | Kya karta hai                                                                                                                                                                 |
| -------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offsite backup | Har 6 ghante (00:15, 06:15, 12:15, 18:15) | App DB + Keycloak DB ka `pg_dump`, data check, SHA-256 manifest, **restic se encrypted** upload server ke bahar (S3/R2), phir retention. Fail hone par email alert.           |
| Retention      | Har backup ke baad                        | Last 7 daily, 4 weekly, 6 monthly snapshots rakhta hai (`BACKUP_KEEP_*` se badal sakte hain).                                                                                 |
| Restore drill  | Har Sunday 03:30                          | Latest offsite snapshot download → checksum → temporary databases mein restore → companies/users, migrations, RLS aur Keycloak realm check → temp DB delete → `restic check`. |
| Monitor        | Har 5 minute                              | Containers (db, redis, keycloak, api, worker, web), disk %, website/API/login URLs, SSL expiry, last backup age (8h) aur last restore drill age (8 din).                      |
| Alerts         | Problem aane par                          | Email: nayi problem par turant (website/container ke liye 2 baar lagatar fail hone par), har 6 ghante reminder, theek hone par "RECOVERED" email.                             |

Deploy ke dauraan monitor apne aap skip hota hai, taaki planned downtime par alert na aaye. Passwords/keys alert email aur logs mein `[redacted]` hote hain.

**Ek limit:** agar poora VPS ya Docker band ho jaye, VPS ka monitor khud email nahi bhej sakta. Iske liye external heartbeat (`HEARTBEAT_URL`, jaise healthchecks.io) lagayein — monitor har run par ping karta hai; ping band hone par wo service alert bhejegi.

## Local tests

```bash
node --test tests/ops.test.mjs tests/rollback.test.mjs   # fast
npm run test:regression                                   # real backup/restore/alerts stage bhi chalata hai
```

Regression mein ek local S3-compatible server (versitygw) par asli encrypted backup, 20 purane snapshots ke saath retention, galat password rejection, restore drill, real container health, worker outage alert/reminder/recovery, missing host data, stale backup aur failed-backup redacted alert test hote hain.

## VPS par one-time setup (ek-ek step karein)

### 1. Offsite storage

Recommended: **Cloudflare R2** (greymetre.io already Cloudflare par hai). Cloudflare → R2 → bucket `rare-os-backups` banayein → **R2 API token** (sirf is bucket ka Object Read & Write). Account ID, Access Key ID aur Secret Access Key note karein.

AWS S3 / Backblaze B2 bhi chalega; sirf `BACKUP_REPOSITORY` format badlega.

### 2. `.env` mein values (VPS par hi, chat/Git mein nahi)

```dotenv
BACKUP_REPOSITORY=s3:https://<ACCOUNT_ID>.r2.cloudflarestorage.com/rare-os-backups
BACKUP_ACCESS_KEY_ID=<r2 access key id>
BACKUP_SECRET_ACCESS_KEY=<r2 secret>
BACKUP_REGION=auto
BACKUP_PASSWORD=<openssl rand -base64 36 se naya>
ALERT_EMAIL_TO=developer1@greymetre.io
MONITOR_URLS=https://rare.greymetre.io/,https://rare.greymetre.io/api/health,https://auth.rare.greymetre.io/realms/rare-os/.well-known/openid-configuration
MONITOR_TLS_HOSTS=rare.greymetre.io,auth.rare.greymetre.io
OPS_SITE=rare.greymetre.io
# optional: HEARTBEAT_URL=https://hc-ping.com/<uuid>
```

**`BACKUP_PASSWORD` ko password manager / offline bhi save karein.** VPS kho gaya aur ye password nahi hai to backup kabhi restore nahi hoga. SMTP ke existing `SMTP_*` values alerts ke liye bhi use hote hain.

### 3. Host commands aur timers install

```bash
cd /var/www/rare-os
sudo install -o root -g root -m 750 scripts/ops/host-run.sh /usr/local/sbin/rare-os-ops
sudo install -o root -g root -m 750 scripts/deploy/rollback.sh /usr/local/sbin/rare-os-rollback
sudo install -o root -g root -m 644 infra/ops/systemd/rare-os-*.service infra/ops/systemd/rare-os-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
```

### 4. Pehli verification (timers enable karne se pehle)

```bash
sudo rare-os-ops init           # encrypted repository banata hai
sudo rare-os-ops test-alert     # inbox mein [RARE OS TEST] email aana chahiye
sudo rare-os-ops backup         # PASS offsite encrypted backup ...
sudo rare-os-ops restore-drill  # PASS restore drill ...
sudo rare-os-ops monitor        # sab OK; backup/drill fresh
```

### 5. Timers on

```bash
sudo systemctl enable --now rare-os-backup.timer rare-os-restore-drill.timer rare-os-monitor.timer
systemctl list-timers 'rare-os-*'
journalctl -u rare-os-backup.service -n 50
```

## Alert aaye to kya karein

| Alert id               | Matlab / pehla kadam                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `container:<service>`  | `docker compose ps -a`, `docker compose logs --tail=100 <service>`. Worker unhealthy = DB/Redis cycle band.        |
| `http:<url>`           | Website/API/login response nahi. Nginx aur containers check karein.                                                |
| `disk:/`               | 85%+ disk. `docker system df`, purane `.local/backups` review karein. Rollback images bina soche delete na karein. |
| `tls:<host>`           | Certificate 14 din se kam. `sudo certbot renew --dry-run`.                                                         |
| `backup:offsite`       | 8 ghante se successful offsite backup nahi. `journalctl -u rare-os-backup.service -n 100`.                         |
| `backup:restore-drill` | 8 din se restore verify nahi hua. `sudo rare-os-ops restore-drill`.                                                |
| `host:facts`           | Monitor ko container/disk status nahi mila — Docker CLI/compose problem.                                           |

## Disaster recovery (VPS/database kho gaya)

Naye server par repo clone, wahi `.env` (especially `BACKUP_*`, `DB_PASSWORD`) rakhein, `docker compose up -d db` karein, phir:

```bash
docker compose --profile ops run --rm --no-deps -T --entrypoint restic ops snapshots
docker compose --profile ops run --rm --no-deps -T --entrypoint sh ops -c \
  'restic restore latest --target /tmp/r && ls -R /tmp/r'
```

Restore hamesha pehle **temporary database** mein karke verify karein (restore drill yahi karta hai), phir planned cutover mein live DB banayein. Live database ke upar seedha restore na karein.

## Rollback (Point 4)

`rare-os-rollback` sirf manual hai (GitHub se nahi chalta). Deploy script har deploy se pehle purani images `rare-os-rollback-<service>:<purana commit>` aur database backup (`.local/deploy/last-backup.txt`) rakhti hai.

1. GitHub variable `VPS_DEPLOY_ENABLED=false` karein (warna agla push wahi release dobara laayega).
2. Pehle bina restore try karein:

   ```bash
   sudo rare-os-rollback <good-commit-sha>
   ```

   Agar naya release migration ya custom Keycloak provider laaya tha to script **exit 2 ke saath mana karegi** aur batayegi kyun — kuch nahi badlega.

3. Tab pre-deploy backup se rollback (deploy ke baad ka data live DB se hat jayega):

   ```bash
   sudo rare-os-rollback <good-commit-sha> \
     --restore-backup "$(cat .local/deploy/last-backup.txt)" --confirm-data-loss
   ```

   Script: backup checksum verify → current data ka safety backup → services stop → live DBs ka naam `*_before_rollback_<time>` (delete nahi) → backup restore → purana commit + purani images → health checks → `.local/deploy/last-rollback.txt`.

4. Login aur records manually check karein. Deploy ke baad aaya data `rare_os_before_rollback_*` mein safe hai; zarurat ho to wahan se reconcile karein. Review ke baad hi purane DB drop karein.
5. Fix push karke checks pass hone par `VPS_DEPLOY_ENABLED=true` — normal deploy wapas naya release laayega.

**Is release ke liye important (live `ddc668a` → MFA/custom Keycloak release):** sirf images wala rollback login tod deta hai (`Unable to find factory for AuthenticatorFactory: rare-verified-otp`), isliye backup-restore wala rollback hi valid hai. Ye local rehearsal mein prove hua — details `docs/VALIDATION.md`.
