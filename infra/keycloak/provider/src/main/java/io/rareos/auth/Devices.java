package io.rareos.auth;
import java.util.*;
import org.keycloak.models.UserModel;
import org.keycloak.credential.CredentialModel;
final class Devices {
  static final String REPLACE = "rare.replace.otp";
  static List<CredentialModel> otp(UserModel u) { return u.credentialManager().getStoredCredentialsByTypeStream("otp").toList(); }
  static boolean owns(UserModel u, String id) { return id != null && otp(u).stream().anyMatch(c -> id.equals(c.getId())); }
  static List<Map<String,String>> labels(UserModel u) {
    return otp(u).stream().map(c -> Map.of("id", c.getId(), "label", c.getUserLabel()==null || c.getUserLabel().isBlank() ? "Unnamed authenticator" : c.getUserLabel())).toList();
  }
}
