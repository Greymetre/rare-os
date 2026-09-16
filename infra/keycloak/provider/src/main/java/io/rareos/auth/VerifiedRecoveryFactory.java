package io.rareos.auth;
import org.keycloak.authentication.*;
import org.keycloak.authentication.authenticators.browser.*;
import org.keycloak.models.KeycloakSession;
public final class VerifiedRecoveryFactory extends RecoveryAuthnCodesFormAuthenticatorFactory {
  @Override public String getId() { return "rare-verified-recovery"; }
  @Override public Authenticator create(KeycloakSession session) {
    return new RecoveryAuthnCodesFormAuthenticator(session) {
      @Override public void action(AuthenticationFlowContext c) {
        super.action(c);
        if (c.getStatus() == org.keycloak.authentication.FlowStatus.SUCCESS)
          c.getAuthenticationSession().setUserSessionNote(AdminPolicy.PROOF, "true");
      }
    };
  }
}
