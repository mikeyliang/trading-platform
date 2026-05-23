# Kubernetes manifests

Production deployment manifests for the trading platform.

## Contents

| File                       | Purpose                                                |
|----------------------------|--------------------------------------------------------|
| `namespace.yaml`           | `trading-platform` namespace                           |
| `configmap.yaml`           | Non-secret runtime configuration                       |
| `secrets.yaml`             | Example secret values — **replace before applying**    |
| `api-deployment.yaml`      | FastAPI deployment (2 replicas, probes, resource caps) |
| `api-service.yaml`         | ClusterIP service for the API on port 8000             |
| `dashboard-deployment.yaml`| Next.js deployment (2 replicas)                        |
| `dashboard-service.yaml`   | ClusterIP service for the dashboard on port 3000       |
| `ingress.yaml`             | Traefik `IngressRoute` + TLS + HTTPS redirect          |

## Apply

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/secrets.yaml        # edit first!
kubectl apply -f k8s/api-deployment.yaml
kubectl apply -f k8s/api-service.yaml
kubectl apply -f k8s/dashboard-deployment.yaml
kubectl apply -f k8s/dashboard-service.yaml
kubectl apply -f k8s/ingress.yaml
```

Or in one shot: `kubectl apply -f k8s/`.

## Prerequisites

- A Kubernetes cluster with the Traefik ingress controller installed and
  `web` (HTTP) + `websecure` (HTTPS) entrypoints configured.
- A certificate resolver named `letsencrypt` (or change the value in
  `ingress.yaml`).
- Postgres reachable at `postgres:5432` and MinIO at `minio:9000` inside
  the cluster (deploy via Helm charts, separate manifests, or external).
- Container images published to `ghcr.io/mikeyliang/trading-platform-api`
  and `ghcr.io/mikeyliang/trading-platform-dashboard`.

## Secrets

`secrets.yaml` ships with placeholder values. For real deployments, manage
secrets with [sealed-secrets](https://github.com/bitnami-labs/sealed-secrets),
[external-secrets](https://external-secrets.io/), or
[SOPS](https://github.com/getsops/sops) rather than committing plain values.
