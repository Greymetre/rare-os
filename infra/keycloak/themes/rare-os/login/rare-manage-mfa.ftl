<#import "template.ftl" as layout>
<@layout.registrationLayout showPageTitle=true; section>
<#if section = "header"><#if disableOnly>Turn off MFA<#else>Manage authenticator devices</#if>
<#elseif section = "form">
<form action="${url.loginAction}" method="post">
<p>These settings apply to this login across all your companies.</p>
<#if !disableOnly>
<label for="deviceId">Device to remove</label><select id="deviceId" name="deviceId"><#list devices as device><option value="${device.id}">${device.label}</option></#list></select>
<p>Remove only a device you no longer use. At least one authenticator must remain. <#if mfaRequired>Administrator MFA cannot be turned off.<#else>Use Turn off MFA to remove all.</#if></p>
<#elseif mfaRequired><p>MFA is required for administrator access and cannot be turned off. You can add or replace authenticator devices.</p>
<#else><p>All authenticator devices and recovery codes will be removed. Future sign-ins will use your password without an authenticator code. Other signed-in sessions will be signed out.</p></#if>
<label class="rare-choice"><input type="checkbox" name="confirmed" value="yes"> I understand and confirm this change.</label>
<button class="pf-c-button pf-m-primary" <#if disableOnly && mfaRequired>disabled</#if> type="submit" name="operation" value="<#if disableOnly>disable<#else>remove</#if>"><#if disableOnly>Turn off MFA<#else>Remove selected device</#if></button>
<button class="rare-cancel" type="submit" name="operation" value="cancel">Cancel</button>
</form>
</#if></@layout.registrationLayout>
