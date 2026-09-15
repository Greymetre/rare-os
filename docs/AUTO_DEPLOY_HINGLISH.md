# GitHub push se Hostinger deployment

## Flow

`main` push / main par Run workflow → existing format/type/unit/build/browser/database/restore checks → deploy job → restricted SSH → running-image rollback tags → same tested commit → VPS build → services pause → app + Keycloak DB backup → migrations/seed/start → public HTTPS checks.

Pull requests aur other branches deploy nahi karte. `VPS_DEPLOY_ENABLED=true` repository variable ke bina job skipped hai. Deploy concurrency aur VPS flock prevent overlapping releases. Older queued SHA agar latest main nahi hai to skip hota hai. Running deployment cancel nahi hota.

Existing VPS target: `/var/www/rare-os`, current `.env` and `compose.override.yaml` preserved. Public endpoints rare.greymetre.io and auth.rare.greymetre.io. Nginx aur dusri applications untouched. Builds abhi VPS par hain; registry-based immutable CI images later improvement hain. Short downtime backup/apply ke waqt expected hai; zero-downtime claim nahi.

## One-time setup (step by step)

### 1. Install deploy command on VPS

SSH root terminal mein latest code pull karke:

```bash
git pull --ff-only origin main
install -o root -g root -m 750 scripts/deploy/vps-deploy.sh /usr/local/sbin/rare-os-deploy
```

Initial install ke baad automation exact commit par detached checkout use karti hai. Routine manual git pull ki zaroorat nahi. Installed deploy script repository se automatically replace nahi hoti; script badalne par reviewed update install karein.

### 2. Dedicated GitHub Actions key

Existing `rare_os_github` key VPS → GitHub read access ke liye hai. Use replace na karein. Yeh nayi key GitHub Actions → VPS ke liye hai.

```bash
ssh-keygen -t ed25519 -f /root/.ssh/rare_os_actions -C rare-os-actions -N ''
```

Agar file already exists warning aaye to overwrite na karein. Public key ke liye one-time restricted authorized_keys entry:

```bash
printf 'restrict,command="/usr/local/sbin/rare-os-deploy" %s\n' "$(cat /root/.ssh/rare_os_actions.pub)" >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
```

This key only accepts `deploy <40-character SHA>`; shell, port forwarding and arbitrary SSH commands are denied. Current server uses root-owned Docker/repo, so key is attached to root with a forced command. Main/workflow write access is deployment authority; grant repository write access only to trusted maintainers.

### 3. GitHub repository secrets

GitHub → Greymetre/rare-os → Settings → Secrets and variables → Actions → Secrets:

| Name            | Value                                                                              |
| --------------- | ---------------------------------------------------------------------------------- |
| VPS_HOST        | 187.127.186.131                                                                    |
| VPS_PORT        | 22                                                                                 |
| VPS_USER        | root                                                                               |
| VPS_SSH_KEY     | `/root/.ssh/rare_os_actions` private key ka full content, BEGIN/END lines included |
| VPS_KNOWN_HOSTS | Neeche trusted VPS host public key se generated line                               |

VPS ke already trusted SSH terminal mein:

```bash
awk '{print "187.127.186.131 " $1 " " $2}' /etc/ssh/ssh_host_ed25519_key.pub
```

Is output ko VPS_KNOWN_HOSTS mein save karein. Host checking disabled nahi hai aur runtime ssh-keyscan par trust nahi karte. Custom SSH port ho to known-hosts name `[host]:port` hona chahiye aur VPS_PORT match kare.

Private key ko sirf GitHub secret mein paste karein; chat, issues, code ya logs mein nahi. App/SMTP/database secrets VPS `.env` mein hi rehte hain.

### 4. Enable and first verification

Variables tab → Repository variable `VPS_DEPLOY_ENABLED` = `true`.

Actions → Foundation checks → Run workflow → branch main. This reruns checks before deploying. Confirm verify and Deploy Hostinger VPS both green; then check website/login manually. Missing secrets fail clearly. Existing Actions billing/runner availability must permit the verify job to run.

After this, future main pushes deploy automatically when checks pass. To pause auto deployment set VPS_DEPLOY_ENABLED=false. Already-running deploy should be allowed to finish; toggling the variable does not cancel it.

## Receipts and recovery

- `.local/deploy/last-success.txt`: successfully checked commit, previous checkout, completion time.
- `.local/deploy/last-failure.txt`: failed commit, prior checkout, failing phase.
- `.local/deploy/last-backup.txt`: validated backup directory; protect this and `.local/backups`.
- `rare-os-rollback-api:<previous-sha>`, worker/web/keycloak tags preserve available running images BEFORE build changes tags. No image/volume pruning is run.
- `.local/deploy/rollback-images-<target-sha>.txt` records each image and rollback tag. If an old image reference is already missing, it records `unavailable`; that service needs a rebuild of the reviewed previous commit for rollback. Never use the new `latest` tag as a substitute for the missing old image. Mandatory DB backup still runs after writes are paused and before migrations.

Build fails: services remain running. Backup fails: old checkout and existing containers are restarted; no migration is applied. Apply/migration/health failure: job fails, no blind schema downgrade or automatic old-code restart. Inspect failure and logs from VPS (avoid sharing sensitive full logs); fix forward or perform a reviewed compatible rollback. A cancelled/killed runner or VPS power loss may interrupt cleanup, so check status before another release.

### Manual application rollback — only after schema compatibility review

1. Pause auto deploy, wait for any running deployment, identify the actual last good SHA from receipts/Actions (the previous checkout is not necessarily healthy after repeated failures).
2. Verify new DB schema is compatible with that application version. Backup current DB before rollback. Incompatible/destructive migration requires a separately reviewed database restore/reconciliation plan, not this command.
3. Check out the chosen good commit on VPS; this also restores its bind-mounted identity theme. Create `.local/deploy/rollback.yaml` with image names `rare-os-rollback-api:<good-sha>`, `rare-os-rollback-worker:<good-sha>`, `rare-os-rollback-web:<good-sha>`, `rare-os-rollback-keycloak:<good-sha>` under their corresponding services. Check these tags exist first.
4. Restart only application services, without running migrations/seeder or deleting volumes:

```bash
docker compose -f compose.yaml -f compose.override.yaml -f .local/deploy/rollback.yaml up -d --no-build --no-deps --force-recreate keycloak api worker web
```

5. Verify HTTPS, login and known records; record rollback. Fix main, rerun checks and enable deployment. Never run `down -v`, schema downgrade, or restore over current DB blindly.

## Validation scope

Local shell syntax, workflow YAML formatting and isolated deployment lifecycle tests cover invalid/stale/dirty commits, build-before-downtime, backup-before-migration, backup recovery, migration/health failures. These tests use fake commands; first real GitHub → VPS run still must pass after secrets/key setup. Backups here are on the VPS; offsite backup/monitoring is point 5, not completed by this pipeline.

GitHub references: [deployment controls](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments), [secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions).

## Installed-script update after the No such image failure

The failed first deploy completed its image build but stopped while tagging an old image ID. It did not reach service stop, backup or migration. Merely retrying with the old installed script repeats this behavior. Install the reviewed repair in `/usr/local/sbin/rare-os-deploy` once; a repository push alone does not replace that root-owned file. Use `git fetch` and `git show <reviewed-sha>:scripts/deploy/vps-deploy.sh` to extract it without changing the running checkout, validate with `bash -n`, then install root-owned mode 750. Re-run the latest main workflow's failed deploy after installation; old runs may be skipped because newer main exists.

Regression tests additionally check image capture before build, missing-image receipts while preserving mandatory backup, and tag failure stopping before build/downtime. Existing checkout/backup/migration safeguards remain.
