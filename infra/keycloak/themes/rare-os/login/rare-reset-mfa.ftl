<#import "template.ftl" as layout>
<@layout.registrationLayout showPageTitle=true; section>
<#if section = "header">Reset password — authenticator choice
<#elseif section = "form">
<form action="${url.loginAction}" method="post">
<p>Your reset email has been verified. Choose whether to keep or replace an authenticator.</p>
<label for="selectedCredentialId">Authenticator device</label>
<select id="selectedCredentialId" name="selectedCredentialId"><#list devices as device><option value="${device.id}">${device.label}</option></#list></select>
<div class="rare-choice"><label><input type="radio" name="choice" value="keep" checked> Keep my authenticators</label><p>Change only your password. Enter a current code from the selected device. No device will be removed.</p>
<div class="rare-keep-code"><label for="otp">Current authenticator code</label><input id="otp" name="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" class="pf-c-form-control" aria-describedby="reset-code-help"><small id="reset-code-help">Use a fresh code from the selected authenticator.</small></div></div>
<div class="rare-choice"><label><input type="radio" name="choice" value="replace"> Replace the selected authenticator</label><p>Use this if you need to scan a new QR code or no longer have this device. The selected old authenticator will stop working after the new code is verified. Other devices stay active.</p><label class="rare-replace-confirm"><input type="checkbox" name="confirmReplace" value="yes"> I understand the selected old authenticator will be replaced.</label></div>
<button class="pf-c-button pf-m-primary" id="rare-reset-continue" type="submit">Continue</button>
</form>
</#if></@layout.registrationLayout>
