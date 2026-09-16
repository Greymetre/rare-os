package io.rareos.auth;
import org.keycloak.authentication.Authenticator;
import org.keycloak.authentication.authenticators.browser.OTPFormAuthenticatorFactory;
import org.keycloak.models.KeycloakSession;
public final class ResetMfaFactory extends OTPFormAuthenticatorFactory {
  @Override public String getId() { return "rare-reset-mfa"; }
  @Override public String getDisplayType() { return "RARE password reset MFA choice"; }
  @Override public Authenticator create(KeycloakSession s) { return new ResetMfa(); }
  @Override public boolean isUserSetupAllowed() { return false; }
}
