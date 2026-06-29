# ArgoCD Setup Runbook — Public LB on tyagi.cloud (Cloudflare SSL)

Same ArgoCD install as before, but the Service is a **public** `LoadBalancer` this time, mapped to `argocd.tyagi.cloud` with a Cloudflare-issued SSL cert.

---

## 0. Prerequisites

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud container clusters get-credentials YOUR_CLUSTER_NAME --zone=YOUR_ZONE
kubectl get nodes
```
One-line: logs into GCP, targets your project, and confirms `kubectl` reaches the cluster.

---

## 0.5. Secrets — Create These BEFORE Installing ArgoCD

`values.yaml` only configures *how* ArgoCD/Dex are deployed (replicas, resources, on/off switches). It does **not** hold any actual sensitive values — no certs, no OAuth secrets. Those live in separate Kubernetes **Secret** objects, created via `kubectl`, that `values.yaml` and the ConfigMap just *reference by name*. They need to exist before `helm install` runs, or ArgoCD/Dex will silently fall back to defaults (self-signed cert, broken SSO) instead of failing loudly.

**Why a separate Secret instead of just writing values into the YAML directly:** ConfigMaps and `values.yaml` are often readable by a much wider group in a cluster than Secrets are — Secrets can be locked down separately via RBAC. So sensitive stuff (cert keys, OAuth client secrets) goes in a Secret; non-sensitive config (replica counts, timeouts, feature flags) goes in `values.yaml`/ConfigMaps.

**Why Dex specifically needs the Google client secret:** when someone clicks "Login via Google," Dex redirects them to Google, Google redirects back with a temporary auth code, and then **Dex has to prove to Google it's really the registered app** by sending the `clientID` + `clientSecret` together. Only if both match does Google hand back the user's verified identity. Without the secret, anyone could try to impersonate your app in that handshake — it's load-bearing for the whole SSO flow to be trustworthy, not a formality.

Keep the actual cert/key files somewhere local, never committed to Git:

```bash
mkdir -p ~/argocd-secrets && cd ~/argocd-secrets
```
One-line: drop your `.crt`/`.key` files here once Cloudflare/your CA gives them to you.

**1. Namespace must exist first** (secrets live inside a namespace):
```bash
kubectl create namespace argocd
```

**2. TLS secret** — whichever cert you end up using (Cloudflare Origin Cert from Section 3, or Let's Encrypt via cert-manager, which creates this one automatically instead):
```bash
kubectl create secret tls argocd-server-tls \
  -n argocd \
  --cert=~/argocd-secrets/cf-origin.crt \
  --key=~/argocd-secrets/cf-origin.key
```
One-line: loads your real cert+key into the secret name `server.certificate.secretName` in `values.yaml` already points at.

**3. Google OAuth secret** — for SSO (Section 4):
```bash
kubectl create secret generic google-oauth \
  -n argocd \
  --from-literal=dex.google.clientSecret="PASTE_CLIENT_SECRET_HERE"
```
One-line: creates a secret named `google-oauth` with one key, `dex.google.clientSecret` — that exact name matters, because `argocd-cm-patch.yaml` in Section 4 looks it up by that exact path (`$google-oauth:dex.google.clientSecret`).

**4. Verify both exist before installing:**
```bash
kubectl get secrets -n argocd
```
Should list `argocd-server-tls` and `google-oauth`.

**Updating a secret later** (rotated cert, new OAuth secret) — `kubectl create` fails with "already exists" on a second run, so use this idempotent form instead:
```bash
kubectl create secret generic google-oauth -n argocd \
  --from-literal=dex.google.clientSecret="NEW_SECRET_HERE" \
  --dry-run=client -o yaml | kubectl apply -f -
```
One-line: works whether the secret already exists or not, no delete step needed.

---

## 1. Install ArgoCD with a Public LB

```bash
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update
kubectl create namespace argocd
```
One-line: adds the ArgoCD chart repo and creates its namespace.

Save as `argocd-values.yaml`:

```yaml
global:
  domain: argocd.tyagi.fun
controller:
  replicas: 1
  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 2000m
      memory: 2Gi
server:
  replicas: 1
  resources:
    requests:
      cpu: 250m
      memory: 256Mi
    limits:
      cpu: 1000m
      memory: 1Gi
  # ArgoCD terminates its own TLS using the cert we create in Section 3.
  ingress:
    enabled: false
  service:
    type: LoadBalancer
    # loadBalancerIP: "10.10.23.4"
    annotations:
      networking.gke.io/load-balancer-type: "Internal"
    servicePortHttps: 443
    servicePortHttp: 80
repoServer:
  replicas: 1
  resources:
    requests:
      cpu: 250m
      memory: 256Mi
    limits:
      cpu: 1000m
      memory: 1Gi
dex:
  enabled: true
  resources:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      cpu: 200m
      memory: 256Mi
applicationSet:
  enabled: true
  replicas: 1
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi
notifications:
  enabled: true
configs:
  cm:
    admin.enabled: "true"
    timeout.reconciliation: 180s
    application.resourceTrackingMethod: label
  params:
    server.insecure: false
  secret:
    createSecret: true
```

The only real difference from the internal version: **no `networking.gke.io/load-balancer-type: "Internal"` annotation**. Leaving it off is what makes GCP hand out a public IP instead of a private one.

```bash
helm install argocd argo/argo-cd \
  --namespace argocd \
  --values argocd-values.yaml \
  --wait --timeout 10m
```
One-line: installs ArgoCD; will wait for pods, but the LB itself may need its cert secret to exist first (see Section 3) or `server.certificate` will just have nothing to load yet — that's fine, ArgoCD falls back to self-signed until the secret shows up.

```bash
kubectl get pods -n argocd
kubectl get svc argocd-server -n argocd
```
One-line: confirms pods are `Running` and shows the public `EXTERNAL-IP` (a real `34.x.x.x`-style address this time, not `10.x.x.x`).

```bash
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d
```
One-line: grabs the initial admin password — needed until SSO is live.

---

### Verify

```bash
curl -vI https://argocd.tyagi.fun
```
One-line: confirms TLS handshake succeeds and no cert warning — should return a `200`/`307` with valid cert info in the `-v` output.

<!-- ---

## 4. Google SSO

### 4a. OAuth client in Google Cloud Console

1. Console → **OAuth consent screen** → app name, your email, scopes `openid`, `userinfo.profile`, `userinfo.email`
2. Console → **Credentials → Create Credentials → OAuth client ID** → **Web application**
3. **Authorized redirect URI**: `https://argocd.tyagi.cloud/api/dex/callback`
4. Copy Client ID + Client Secret

One-line: registers ArgoCD as an app Google will issue login tokens to, restricted to that exact redirect URL.

```bash
kubectl create secret generic google-oauth \
  -n argocd \
  --from-literal=dex.google.clientSecret="PASTE_CLIENT_SECRET_HERE"
```
One-line: stores the OAuth secret as a K8s secret instead of plaintext in a ConfigMap.

Save as `argocd-cm-patch.yaml`:
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  url: "https://argocd.tyagi.cloud"
  dex.config: |
    connectors:
      - type: google
        id: google
        name: Google
        config:
          clientID: PASTE_CLIENT_ID_HERE
          clientSecret: $google-oauth:dex.google.clientSecret
          redirectURI: https://argocd.tyagi.cloud/api/dex/callback
          hostedDomains:
            - yourcompany.com
```
```bash
kubectl apply -f argocd-cm-patch.yaml
kubectl rollout restart deployment argocd-dex-server -n argocd
kubectl rollout restart deployment argocd-server -n argocd
```
One-line: wires Dex to Google and restarts both pods to pick it up.

Test by visiting `https://argocd.tyagi.cloud` and clicking **Login via Google** before doing anything else.

### 4b. Lock down local admin (only after SSO confirmed working)

```bash
kubectl patch configmap argocd-cm -n argocd --type merge -p '{"data":{"admin.enabled":"false"}}'
kubectl rollout restart deployment argocd-server -n argocd
```
One-line: disables the local admin password login entirely — this matters a lot more on a public LB than an internal one.

Escape hatch if locked out:
```bash
kubectl patch configmap argocd-cm -n argocd --type merge -p '{"data":{"admin.enabled":"true"}}'
kubectl rollout restart deployment argocd-server -n argocd
```

---

## 5. RBAC

Save as `argocd-rbac.yaml`:
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
data:
  policy.default: role:readonly
  policy.csv: |
    p, role:admin, applications, *, */*, allow
    p, role:admin, projects, *, *, allow
    p, role:admin, repositories, *, *, allow
    p, role:admin, certificates, *, *, allow
    p, role:admin, accounts, *, *, allow

    p, role:developer, applications, get, */*, allow
    p, role:developer, applications, sync, */*, allow
    p, role:developer, applications, rollback, */*, allow
    p, role:developer, projects, get, *, allow
    p, role:developer, repositories, get, *, allow
    p, role:developer, applications, create, */*, deny
    p, role:developer, applications, delete, */*, deny

    p, role:readonly, applications, get, */*, allow
    p, role:readonly, projects, get, *, allow
    p, role:readonly, repositories, get, *, allow

    g, your-email@yourcompany.com, role:admin
    g, dev-email@yourcompany.com, role:developer

  scopes: "[email, groups]"
```
One-line: defines admin/developer/readonly roles, mapped by email — unlisted users default to readonly.

```bash
kubectl apply -f argocd-rbac.yaml
kubectl rollout restart deployment argocd-server -n argocd
```
One-line: applies and restarts to pick up the new policy.

---

## Sanity checklist

```
□ kubectl get svc argocd-server -n argocd → EXTERNAL-IP is a real public IP (34.x.x.x style)
□ Cloudflare A record argocd.tyagi.cloud → that IP
□ https://argocd.tyagi.cloud loads with a trusted cert, no browser warning
□ Google SSO login works BEFORE disabling admin
□ admin.enabled set to false after SSO confirmed
□ RBAC applied — test admin vs developer vs readonly accounts
□ (Optional but recommended) Cloudflare proxy is orange-cloud, not grey
```

## If something breaks

| Symptom | Fix |
|---|---|
| Cert warning despite Cloudflare Origin Cert | SSL/TLS mode in Cloudflare must be **Full (strict)**, not Flexible — Flexible doesn't check your origin cert at all and can even loop |
| `522`/`523` error from Cloudflare | LB's public IP unreachable or firewall blocking port 443 — check `gcloud compute firewall-rules list` |
| cert-manager `Certificate` stuck not Ready | `kubectl describe certificate argocd-server-tls -n argocd` — usually a bad Cloudflare API token scope (needs `Zone:DNS:Edit`) |
| `redirect_uri_mismatch` | Must exactly match `https://argocd.tyagi.cloud/api/dex/callback`, including no trailing slash |
| Locked out after disabling admin | Re-enable patch command in Section 4b | -->