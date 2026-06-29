# ArgoCD GitOps — Mental Model + Command Cheatsheet

> Built from a real debugging session: gitops-repo → ArgoCD → GKE, dev/prod/uat, App-of-Apps pattern.
> Goal of this doc: next time you set up a NEW project, you debug by **understanding the flow**, not by re-discovering it the hard way.

---

## 1. The Core Mental Model — "Who Creates Whom"

Think of ArgoCD as **4 layers stacked on top of real Kubernetes**, each layer only able to do what the layer above it allows.

```
┌─────────────────────────────────────────────────────────┐
│  LAYER 0: Kubernetes RBAC                                │
│  "Does ArgoCD's own ServiceAccount have permission       │
│   to do ANYTHING on this cluster at all?"                │
│  (ClusterRole / ClusterRoleBinding on argocd-application-controller) │
└─────────────────────────────────────────────────────────┘
                          ↓ governs
┌─────────────────────────────────────────────────────────┐
│  LAYER 1: AppProject                                      │
│  "Within what ArgoCD is allowed to do, what is THIS      │
│   project specifically allowed to touch?"                │
│  - which git repos (sourceRepos)                          │
│  - which namespaces/clusters (destinations)               │
│  - which K8s resource KINDS (whitelists)                  │
└─────────────────────────────────────────────────────────┘
                          ↓ governs
┌─────────────────────────────────────────────────────────┐
│  LAYER 2: Application (parent — "App of Apps")            │
│  "Go watch this git path. Whatever Application YAMLs      │
│   are in there, create them as real Applications."        │
└─────────────────────────────────────────────────────────┘
                          ↓ creates
┌─────────────────────────────────────────────────────────┐
│  LAYER 3: Application (child — actual workload)           │
│  "Go watch THIS git path. Render this Helm chart with     │
│   these values, and apply the resulting manifests."       │
└─────────────────────────────────────────────────────────┘
                          ↓ creates
┌─────────────────────────────────────────────────────────┐
│  LAYER 4: Real Kubernetes Resources                       │
│  Deployment → ReplicaSet → Pod, Service, ConfigMap, etc.   │
└─────────────────────────────────────────────────────────┘
```

**The single most important idea:** every box from Layer 1 downward is just a `kubectl get`-able object. `AppProject` and `Application` are not "ArgoCD magic" — they are **CRDs** (Custom Resource Definitions) that ArgoCD installs into your cluster. Once installed, `kubectl` treats them exactly like `Deployment` or `Service`. There is no separate "ArgoCD database" — everything ArgoCD knows is sitting in `etcd` as ordinary Kubernetes objects in the `argocd` namespace.

```bash
# Proof — these are real CRDs, not built-ins:
kubectl get crd | grep argoproj.io
kubectl api-resources | grep argoproj
```

---

## 2. The Two Kinds of "Permission" — Don't Confuse Them

This was the single biggest source of confusion in our debugging session. There are **two separate gatekeepers**, and an error can come from either one:

| | **AppProject Whitelist** | **Kubernetes RBAC (ClusterRole)** |
|---|---|---|
| **What it controls** | What ArgoCD's *Application* objects are allowed to manage, per-project | What ArgoCD's *ServiceAccount* is physically allowed to do on the cluster |
| **Where it lives** | `spec.namespaceResourceWhitelist`, `spec.clusterResourceWhitelist`, `spec.sourceRepos`, `spec.destinations` inside the `AppProject` YAML | `ClusterRole` / `ClusterRoleBinding` bound to `argocd-application-controller` |
| **Analogy** | Company policy: "you're allowed in the server room" | Your keycard: "does it actually open the door" |
| **Error you'll see if missing** | `resource X is not permitted in project Y` / `InvalidSpecError` | Silent failure, or `forbidden: User "system:serviceaccount:argocd:..." cannot create resource` |
| **How to check** | `kubectl get appproject <name> -n argocd -o yaml` | `kubectl auth can-i create namespaces --as=system:serviceaccount:argocd:argocd-application-controller` |
| **Who edits it** | You, constantly, as you add new resource kinds to your charts | Almost never — set once at ArgoCD install time |

**Rule of thumb when debugging:** if the error message explicitly says *"not permitted in project X"* → it's the AppProject whitelist, 100% of the time. If you get a generic Kubernetes `forbidden` error with no mention of "project," it's RBAC.

### Answering your direct question: "Do I put RBAC on the projects, individually?"

**No — and this is the key insight.** RBAC (Layer 0) is set **once**, on the ArgoCD installation itself, and it applies globally to every project. You do **not** configure RBAC per-AppProject.

What you **do** configure per-project is the **whitelist** (Layer 1) — and yes, that genuinely is per-project, individually, on purpose. That's the entire reason AppProjects exist: so `dev` can be loose (auto-sync, broad whitelist) while `uat`/`prod` can be tight (manual sync, narrow whitelist, restricted destinations) — all on the *same* underlying cluster RBAC.

So the mental split is:
- **RBAC = "can ArgoCD do this at all, anywhere"** → set once, cluster-wide
- **AppProject whitelist = "can THIS team/environment do this, specifically"** → set per-project, deliberately different across dev/uat/prod

---

## 3. How The YAML Files Actually Wire Together

This is the "how do labels/paths/names connect across files" question. Walk through it as a literal trace:

```yaml
# ── 1. AppProject (gitops-repo/argocd/projects/dev.yaml) ──
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: dev                                    # ← (A) other files reference this by name
spec:
  sourceRepos:
    - 'https://github.com/you/repo.git'        # ← (B) must match repoURL in every Application below
  destinations:
    - namespace: 'java-app-dev'                # ← (C) must match destination.namespace in child Applications
      server: https://kubernetes.default.svc
  namespaceResourceWhitelist:
    - group: 'argoproj.io'
      kind: Application                        # ← (D) REQUIRED if this project will create child Apps (App-of-Apps)
```

```yaml
# ── 2. Parent Application (gitops-repo/argocd/parents/dev-environment.yaml) ──
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: dev-environment
spec:
  project: dev                                 # ← references (A) — MUST match AppProject metadata.name exactly
  source:
    repoURL: 'https://github.com/you/repo.git' # ← MUST match (B), or InvalidSpecError
    path: gitops-repo/argocd/apps/dev          # ← (E) the FOLDER containing child Application YAMLs
  destination:
    namespace: argocd                          # ← parent itself lives in argocd namespace (it manages OTHER Applications, which are cluster-level-ish objects)
```

```yaml
# ── 3. Child Application (gitops-repo/argocd/apps/dev/java-dev.yaml — discovered via path (E)) ──
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: java-app-dev
spec:
  project: dev                                 # ← again references (A)
  source:
    repoURL: 'https://github.com/you/repo.git'
    path: gitops-repo/helm                     # ← (F) the Helm CHART folder (Chart.yaml lives here)
    helm:
      valueFiles:
        - values.yaml                          # ← chart's own defaults, relative to (F)
        - ../applications/dev/java-app-dev-values.yaml  # ← (G) environment-specific overrides, relative to (F)
  destination:
    namespace: java-app-dev                    # ← MUST be listed in (C), or "not permitted in project"
```

```yaml
# ── 4. Values file (gitops-repo/applications/dev/java-app-dev-values.yaml — referenced by (G)) ──
global:
  namespace: java-app-dev                      # ← (H) consumed by Helm templates as {{ .Values.global.namespace }}
deployment:
  image:
    name: "docker.io/vishu0210/java-app-dev"
    tag: "latest"
```

```yaml
# ── 5. Helm template (gitops-repo/helm/templates/service.yaml — inside folder (F)) ──
metadata:
  namespace: {{ .Values.global.namespace | quote }}   # ← reads (H). If (H) is missing, this renders EMPTY,
                                                         #   and Kubernetes silently defaults to the "default" namespace.
```

**Every one of those arrows is a place a typo silently breaks the chain** — and almost every bug in our debugging session was exactly one of these arrows pointing at the wrong thing:
- (A) mismatch → `InvalidSpecError`
- (B) mismatch → `application repo ... is not permitted in project`
- (C) missing the destination namespace → `not permitted in project`
- (D) missing → `resource argoproj.io:Application is not permitted in project`
- (E)/(F) wrong path → `ComparisonError: app path does not exist`
- (G) wrong relative path math → values file not found / wrong values applied
- (H) missing in values file → resources silently land in `default` namespace

### Labels — what they actually do (and don't do)

```yaml
metadata:
  labels:
    environment: dev
    app: java-app-dev
```

**Important:** these labels are **NOT** functional wiring like the fields above. They don't connect anything, they don't get read by ArgoCD's sync logic. They exist purely for:
1. **UI filtering** — the "Resource filters" sidebar in the ArgoCD UI groups/filters by these
2. **`kubectl` filtering** — `kubectl get application -l environment=dev`
3. **Human readability** — at a glance, "oh this belongs to dev"

If you delete every label from every file in this whole setup, **the GitOps pipeline still works identically**. Labels are metadata for humans and UIs, not instructions for ArgoCD's reconciliation engine. Don't confuse them with the `spec.project`, `repoURL`, `path`, and `destination.namespace` fields — those are the real wiring; labels are just sticky notes.

---

## 4. Debugging Framework — Questions to Ask, In Order

When something's broken, don't guess randomly — walk this checklist top-down, because each layer can only be correct if the layer above it is correct:

```
1. Is ArgoCD's ServiceAccount allowed to do this at all? (RBAC)
   → kubectl auth can-i <verb> <resource> --as=system:serviceaccount:argocd:argocd-application-controller

2. Does the live AppProject in the cluster actually match what's in git?
   → kubectl get appproject <name> -n argocd -o yaml
   (Did you edit the FILE but forget to `kubectl apply` it again? This bit us twice.)

3. Is the Application's `spec.project` field spelled exactly like the AppProject's `metadata.name`?

4. Does `repoURL` match EXACTLY (including .git, http vs https) between AppProject.sourceRepos
   and every Application.source.repoURL?

5. Does `destination.namespace` actually appear in AppProject.spec.destinations?

6. If this Application creates OTHER Applications (App-of-Apps),
   does the AppProject whitelist `{group: argoproj.io, kind: Application}`?

7. Does `source.path` actually exist at the resolved git revision?
   → git ls-tree -r HEAD --name-only | grep <path>
   (Not "does it exist on my laptop" — does it exist in the COMMITTED, PUSHED tree.)

8. Is ArgoCD's cached revision the same as git's actual HEAD?
   → kubectl get application <name> -n argocd -o jsonpath='{.status.sync.revision}'
   → git log --oneline -1
   (Mismatch = hasn't picked up your push yet, or stale repo-server cache → hard refresh)

9. For Helm-based apps: do relative valueFiles paths actually resolve correctly
   from `source.path` as the base? (Not from repo root — from the CHART folder.)

10. Does the namespace this Application targets actually exist?
    → kubectl get namespace <name>
    (If using CreateNamespace=true and it's a brand-new first sync, this can race —
     manually `kubectl create namespace` once to break the deadlock.)

11. Did ArgoCD successfully render+apply manifests? (Synced ≠ Healthy!)
    → kubectl get application <name> -n argocd
    Synced  = ArgoCD successfully pushed manifests to the cluster
    Healthy = the actual workload (pod) is running and passing probes
    These are INDEPENDENT. You can be Synced + Degraded — that's a workload
    problem (bad image, crashing app), not a GitOps plumbing problem.

12. If Degraded specifically: is it the IMAGE (ImagePullBackOff) or the APP ITSELF
    (CrashLoopBackOff, readiness probe failing)?
    → kubectl describe pod <pod> -n <namespace>   (read the Events section)
    → kubectl logs <pod> -n <namespace>
```

**The single most useful diagnostic command, full stop:**
```bash
kubectl get application <name> -n argocd -o json | jq '.status.operationState.syncResult.resources'
```
This shows the **per-resource** failure reason — far more specific than the generic top-level condition banner in the UI, which often shows a stale/cached summary message.

---

## 5. Quick Reference — Commands

### Inspect the hierarchy
```bash
kubectl get appproject -n argocd
kubectl get appproject <name> -n argocd -o yaml

kubectl get applications -n argocd          # parent AND child apps — same object type
kubectl get application <name> -n argocd -o yaml

kubectl get all -n <target-namespace>       # the actual workload
kubectl get pods -n <target-namespace>
```

### Diagnose
```bash
kubectl describe pod <pod> -n <namespace>
kubectl logs <pod> -n <namespace>
kubectl logs <pod> -n <namespace> --previous

kubectl get application <name> -n argocd -o jsonpath='{.status.operationState.message}'
kubectl get application <name> -n argocd -o json | jq '.status.operationState.syncResult.resources'

kubectl auth can-i create namespaces --as=system:serviceaccount:argocd:argocd-application-controller
```

### Force a refresh / sync
```bash
# Refresh = re-read git, recompute diff (doesn't apply)
kubectl patch application <name> -n argocd --type merge \
  -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"hard"}}}'

# Sync = actually apply the diff
kubectl patch application <name> -n argocd --type merge -p '{"operation":{"sync":{}}}'
```

If you have the ArgoCD CLI installed, these are shorter:
```bash
argocd login argocd.tyagi.fun
argocd app sync <name>
argocd app get <name>
```

### Bootstrap a brand-new environment from zero
```bash
# 1. Projects first (defines the sandbox)
kubectl apply -f gitops-repo/argocd/projects/dev.yaml

# 2. Parent app (App-of-Apps — creates children automatically)
kubectl apply -f gitops-repo/argocd/parents/dev-environment.yaml

# 3. Just watch — don't manually apply child YAMLs, the parent does it
kubectl get applications -n argocd -w
```

### Nuke and rebuild (when state gets too tangled to trust)
```bash
# Delete children → parents → projects (reverse of creation order)
kubectl delete application java-app-dev react-app-dev -n argocd --ignore-not-found
kubectl delete application dev-environment -n argocd --ignore-not-found
kubectl delete appproject dev -n argocd --ignore-not-found

# If anything hangs in Terminating (finalizer stuck):
kubectl patch application <name> -n argocd -p '{"metadata":{"finalizers":null}}' --type merge
kubectl patch appproject <name> -n argocd -p '{"metadata":{"finalizers":null}}' --type merge

# Clear ArgoCD's manifest cache (kills stale "(cached)" errors):
kubectl delete pod -n argocd -l app.kubernetes.io/name=argocd-repo-server

# Re-apply in correct order
kubectl apply -f gitops-repo/argocd/projects/dev.yaml
kubectl apply -f gitops-repo/argocd/parents/dev-environment.yaml
```

### Redeploy after a code change
```bash
docker build -t vishu0210/java-app-dev:v2 .
docker push vishu0210/java-app-dev:v2

# update tag in git values file, then:
git add . && git commit -m "bump to v2" && git push origin main

kubectl patch application java-app-dev -n argocd --type merge -p '{"operation":{"sync":{}}}'
kubectl rollout status deployment/java-app-dev-microservice-app -n java-app-dev
```

### Rollback
```bash
kubectl get application <name> -n argocd -o jsonpath='{.status.history}'
# or simplest: revert the git commit, let selfHeal pull it back
git revert HEAD && git push origin main
```

---

## 6. The One-Paragraph Version (for when you're in a hurry next time)

> ArgoCD is just CRDs sitting in `etcd`. RBAC (set once, cluster-wide) decides if ArgoCD's controller can touch the cluster at all. An **AppProject** is a per-environment sandbox: which repo, which namespaces, which K8s kinds are allowed — including, critically, whether it's allowed to create *other Applications* (needed for App-of-Apps). A **parent Application** just points at a git folder and says "treat every YAML in here as something to apply" — when those YAMLs are themselves Applications, that's the App-of-Apps pattern, and the children appear automatically. A **child Application** points at a Helm chart path plus a values file, and Helm renders real Kubernetes manifests from that. **Synced** means ArgoCD successfully pushed manifests to the cluster; **Healthy** means the resulting pod is actually running and passing probes — these are independent, and "Synced but Degraded" always means a workload problem (bad image, crashing app), never a GitOps wiring problem. Debug top-down through this stack, never bottom-up by guessing.





kubectl apply -f gitops-repo/argocd/projects/dev.yaml
kubectl apply -f gitops-repo/argocd/projects/prod.yaml
kubectl apply -f gitops-repo/argocd/projects/uat.yaml
kubectl apply -f gitops-repo/argocd/parents/dev-environment.yaml
kubectl apply -f gitops-repo/argocd/parents/prod-environment.yaml
kubectl apply -f gitops-repo/argocd/parents/uat-environment.yaml

# Then just watch:
kubectl get applications -n argocd -w
