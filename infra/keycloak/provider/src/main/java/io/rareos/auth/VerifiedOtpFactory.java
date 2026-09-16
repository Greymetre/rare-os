package io.rareos.auth;
import org.keycloak.authentication.*;
import org.keycloak.authentication.authenticators.browser.*;
import org.keycloak.models.KeycloakSession;
public final class VerifiedOtpFactory extends OTPFormAuthenticatorFactory {
  @Override public String getId() { return "rare-verified-otp"; }
  @Override public Authenticator create(KeycloakSession session) {
    return new OTPFormAuthenticator() {
      @Override public void action(AuthenticationFlowContext c) {
        super.action(c);
        if (c.getStatus() == org.keycloak.authentication.FlowStatus.SUCCESS)
          c.getAuthenticationSession().setUserSessionNote(AdminPolicy.PROOF, "true");
      }
    };
  }
}
