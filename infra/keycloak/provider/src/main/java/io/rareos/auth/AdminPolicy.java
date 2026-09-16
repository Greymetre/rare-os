package io.rareos.auth;
import java.sql.DriverManager;
import java.util.Properties;
import org.keycloak.models.UserModel;
/** Consult authoritative account-wide grants, never user-editable profile attributes. */
final class AdminPolicy {
  static final String PROOF = "rare_mfa_verified";
  static boolean required(UserModel user) {
    var settings = new Properties();
    settings.setProperty("user", System.getenv("KC_DB_USERNAME"));
    settings.setProperty("password", System.getenv("KC_DB_PASSWORD"));
    settings.setProperty("connectTimeout", "5");
    settings.setProperty("socketTimeout", "5");
    try (var db = DriverManager.getConnection(System.getenv("RARE_POLICY_DB_URL"), settings);
         var query = db.prepareStatement("SELECT public.identity_requires_mfa(?)")) {
      query.setString(1, user.getId());
      try (var result = query.executeQuery()) {
        if (!result.next()) throw new IllegalStateException("Missing MFA policy");
        return result.getBoolean(1);
      }
    } catch (Exception failure) {
      // Do not log JDBC credentials or turn an outage into an MFA exemption.
      throw new IllegalStateException("Account security policy is unavailable");
    }
  }
}
