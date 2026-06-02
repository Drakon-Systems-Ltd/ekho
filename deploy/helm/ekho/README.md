# Ekho Helm Chart

Helm chart for deploying the [Ekho](https://github.com/Drakon-Systems-Ltd/ekho)
signed agent messaging relay to Kubernetes.

## TL;DR

```bash
helm install ekho ./deploy/helm/ekho \
  --namespace ekho --create-namespace \
  --set secrets.operatorSessionSecret=$(openssl rand -hex 32)
```

Then port-forward and open the console:

```bash
kubectl -n ekho port-forward svc/ekho 4000:4000
# http://localhost:4000/ui/
```

## Prerequisites

- Kubernetes 1.23+
- Helm 3.8+
- A default StorageClass that supports `ReadWriteOnce` (or override
  `persistence.storageClass`)

## Installation

### Minimal install (dev/test)

```bash
helm install ekho ./deploy/helm/ekho \
  --namespace ekho --create-namespace \
  --set secrets.operatorSessionSecret=$(openssl rand -hex 32)
```

### Production install

Create a `values.prod.yaml`:

```yaml
image:
  repository: ghcr.io/drakon-systems-ltd/ekho
  tag: "0.2.1"

persistence:
  enabled: true
  size: 5Gi
  storageClass: "longhorn"   # or your preferred CSI class

resources:
  requests:
    cpu: 250m
    memory: 512Mi
  limits:
    cpu: "1"
    memory: 1Gi

config:
  EKHO_BASE_URL: "https://ekho.example.com"
  EKHO_RATE_LIMIT_MAX_MESSAGES: "60"

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
  hosts:
    - host: ekho.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: ekho-tls
      hosts:
        - ekho.example.com

secrets:
  operatorSessionSecret: ""   # set via --set or a sealed secret
  # licenseKey: ""             # Pro license JWT, optional
```

Install:

```bash
helm install ekho ./deploy/helm/ekho \
  --namespace ekho --create-namespace \
  -f values.prod.yaml \
  --set secrets.operatorSessionSecret=$(openssl rand -hex 32)
```

### Using an existing Secret

If you manage secrets with SealedSecrets, ExternalSecrets, Vault, etc.,
point the chart at an existing Secret that exposes
`EKHO_OPERATOR_SESSION_SECRET` (and optionally `EKHO_LICENSE_KEY`):

```yaml
secrets:
  existingSecret: ekho-credentials
```

## Upgrading

```bash
helm upgrade ekho ./deploy/helm/ekho \
  -n ekho \
  -f values.prod.yaml \
  --reuse-values \
  --set image.tag=0.2.1
```

The StatefulSet rolls pods one at a time, terminating the old pod before
starting the new one. Expect a brief (10-30s) window of downtime per
upgrade — this is inherent to single-writer SQLite.

SQLite migrations run on startup. Back up the PVC before upgrading if the
release notes call out a schema change.

### Backing up the database

```bash
kubectl -n ekho exec ekho-0 -- tar c -C /app data | gzip > ekho-backup-$(date +%F).tar.gz
```

## Uninstalling

```bash
helm uninstall ekho -n ekho
```

Note: Helm does not delete PVCs created by StatefulSet `volumeClaimTemplates`
by default. Delete them manually if you want the data gone:

```bash
kubectl -n ekho delete pvc -l app.kubernetes.io/instance=ekho
```

## Why replicaCount must stay at 1

Ekho stores its entire state in SQLite via `better-sqlite3`. SQLite uses an
exclusive file lock for writes — two processes writing to the same database
file simultaneously will corrupt it. Because of this:

- `replicaCount` MUST be `1`.
- Horizontal Pod Autoscaling is disabled by default and should NOT be enabled.
- The StatefulSet uses a single-replica `volumeClaimTemplate` so the PVC is
  pinned to `ekho-0`.
- Rolling upgrades tear down the old pod BEFORE starting the new one.

If you need horizontal scale, you're outgrowing Ekho's single-binary model.
Talk to us about the Pro / Enterprise tier, which replaces SQLite with a
networked backend.

## Configuration reference

| Key | Default | Description |
|---|---|---|
| `image.repository` | `ghcr.io/drakon-systems-ltd/ekho` | Container image |
| `image.tag` | `0.2.1` | Image tag |
| `image.pullPolicy` | `IfNotPresent` | Image pull policy |
| `replicaCount` | `1` | Must stay 1 — see above |
| `service.type` | `ClusterIP` | Service type |
| `service.port` | `4000` | Service port |
| `ingress.enabled` | `false` | Enable ingress |
| `ingress.className` | `""` | Ingress class |
| `ingress.hosts` | `[ekho.local]` | Ingress host rules |
| `ingress.tls` | `[]` | TLS configuration |
| `persistence.enabled` | `true` | Use a PVC for SQLite |
| `persistence.size` | `1Gi` | PVC size |
| `persistence.storageClass` | `""` | StorageClass; empty = cluster default |
| `resources.requests.cpu` | `100m` | CPU request |
| `resources.requests.memory` | `256Mi` | Memory request |
| `resources.limits.cpu` | `500m` | CPU limit |
| `resources.limits.memory` | `512Mi` | Memory limit |
| `secrets.operatorSessionSecret` | `""` | REQUIRED. Operator session signing key |
| `secrets.licenseKey` | `""` | Optional Pro license JWT |
| `secrets.existingSecret` | `""` | Use an existing Secret instead |
| `config.EKHO_*` | see `values.yaml` | Non-secret env vars |
| `podSecurityContext.fsGroup` | `1000` | fsGroup for PVC ownership |
| `securityContext.runAsNonRoot` | `true` | Run as non-root |
| `securityContext.runAsUser` | `1000` | UID to run as |

See [values.yaml](./values.yaml) for the full list.

## Troubleshooting

**Pod won't start — CrashLoopBackOff**

Check the logs:

```bash
kubectl -n ekho logs ekho-0
```

Common causes:

- Missing `secrets.operatorSessionSecret` — the chart refuses to install
  without this, but an `existingSecret` that doesn't have the right keys
  will fail at startup instead.
- PVC can't bind — check `kubectl -n ekho get pvc`. Fix with
  `persistence.storageClass` override.

**Can't access `/ui/`**

Ensure the port-forward is alive and you're hitting `/ui/` (with the
trailing slash).

**Operator login says "invalid credentials"**

You need to create an operator account first. Exec into the pod:

```bash
kubectl -n ekho exec -it ekho-0 -- tsx packages/relay/src/scripts/create-operator.ts
```

## Support

- GitHub: <https://github.com/Drakon-Systems-Ltd/ekho>
- Email: support@drakonsystems.com
