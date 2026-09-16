FROM quay.io/keycloak/keycloak:26.7.3 AS keycloak-base
FROM alpine:3.23 AS keycloak-patches
RUN apk add --no-cache curl \
  && curl --fail --silent --show-error --location \
    --output /netty-handler-4.1.137.Final.jar \
    https://repo1.maven.org/maven2/io/netty/netty-handler/4.1.137.Final/netty-handler-4.1.137.Final.jar \
  && echo 'd0e4c6ee4779f59f6ab2fb5d388e4f57147c82270164b37945764bb9bda96a44  /netty-handler-4.1.137.Final.jar' | sha256sum -c -
FROM eclipse-temurin:21-jdk AS provider-build
WORKDIR /build
COPY --from=keycloak-base /opt/keycloak/lib/lib/main/ /deps/
COPY infra/keycloak/provider/src/main/java/ src/
COPY infra/keycloak/provider/src/main/resources/ resources/
RUN mkdir classes && javac -cp '/deps/*' -d classes $(find src -name '*.java') && jar --create --file rare-os-auth.jar -C classes . -C resources .
FROM keycloak-base
COPY --from=provider-build --chown=1000:0 /build/rare-os-auth.jar /opt/keycloak/providers/rare-os-auth.jar
# Keep the distribution filename because Keycloak's prebuilt classpath indexes it; jar metadata carries 4.1.137.
COPY --from=keycloak-patches --chown=1000:0 /netty-handler-4.1.137.Final.jar /opt/keycloak/lib/lib/main/io.netty.netty-handler-4.1.136.Final.jar
RUN /opt/keycloak/bin/kc.sh build --db=postgres --health-enabled=true
USER 1000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=10 CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/9000; printf 'GET /health/ready HTTP/1.0\r\n\r\n' >&3; grep -q '200 OK' <&3"]
