#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
IMAGE_NAME="${IMAGE_NAME:-tars-tars:latest}"
K8S_NAMESPACE="${K8S_NAMESPACE:-agents}"
K8S_DEPLOYMENT="${K8S_DEPLOYMENT:-tars}"
K8S_MANIFEST="${K8S_MANIFEST:-${REPO_ROOT}/deploy/k3s/tars.yaml}"
K8S_TIMEOUT="${K8S_TIMEOUT:-10m}"

cd "${REPO_ROOT}"

if [[ ! -f "${K8S_MANIFEST}" ]]; then
  echo "Kubernetes manifest not found: ${K8S_MANIFEST}" >&2
  exit 1
fi

echo "[$(date -Iseconds)] Building ${IMAGE_NAME} from ${REPO_ROOT}"
docker build --tag "${IMAGE_NAME}" .

echo "Importing ${IMAGE_NAME} into k3s containerd"
docker save "${IMAGE_NAME}" | sudo -n k3s ctr -n k8s.io images import -

echo "Applying manifest ${K8S_MANIFEST}"
sudo -n kubectl apply -f "${K8S_MANIFEST}"

echo "Restarting deployment ${K8S_NAMESPACE}/${K8S_DEPLOYMENT}"
sudo -n kubectl -n "${K8S_NAMESPACE}" rollout restart "deployment/${K8S_DEPLOYMENT}"
sudo -n kubectl -n "${K8S_NAMESPACE}" rollout status "deployment/${K8S_DEPLOYMENT}" --timeout="${K8S_TIMEOUT}"

echo "Current pods:"
sudo -n kubectl -n "${K8S_NAMESPACE}" get pods -l "app=${K8S_DEPLOYMENT}" -o wide

echo "[$(date -Iseconds)] Deploy complete"
