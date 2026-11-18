# Multi-stage: the SDK is ~800MB and is only needed to compile. Only the
# runtime and the published output ship.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# Copy project files first and restore on their own layer. Docker caches that
# layer until a .csproj changes, so editing C# does not re-download NuGet.
COPY Apex.KeyMapping.Api/Apex.KeyMapping.Api.csproj Apex.KeyMapping.Api/
RUN dotnet restore Apex.KeyMapping.Api/Apex.KeyMapping.Api.csproj

COPY Apex.KeyMapping.Api/ Apex.KeyMapping.Api/
RUN dotnet publish Apex.KeyMapping.Api/Apex.KeyMapping.Api.csproj \
    -c Release \
    -o /app/publish \
    --no-restore \
    # The OpenAPI document is generated at build time by starting the host,
    # which needs configuration this image does not have. CI generates and
    # diffs it separately; skip it here.
    -p:OpenApiGenerateDocuments=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app

# curl for the container health check in the ECS task definition. The runtime
# image does not ship one.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/publish .

# Kestrel defaults to port 8080 in containers; being explicit keeps this in
# step with the port the task definition maps.
ENV ASPNETCORE_HTTP_PORTS=8080
EXPOSE 8080

# Run as the non-root `app` user the base image already ships (uid 1654).
# Creating another one is how this first failed: uid 1000 is taken by
# `ubuntu`. The EFS access point is pinned to this same uid so ownership on
# the mount is consistent with ownership in the image.
RUN chown -R app:app /app
USER app

ENTRYPOINT ["dotnet", "Apex.KeyMapping.Api.dll"]
