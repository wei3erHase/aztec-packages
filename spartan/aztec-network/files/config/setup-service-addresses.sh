#!/bin/bash

set -ex

# Function to get pod and node details
get_service_address() {
    local SERVICE_LABEL=$1
    local PORT=$2
    local MAX_RETRIES=30
    local RETRY_INTERVAL=2
    local attempt=1

    # Get pod name
    while [ $attempt -le $MAX_RETRIES ]; do
        POD_NAME=$(kubectl get pods -n ${NAMESPACE} -l app=${SERVICE_LABEL} -o jsonpath='{.items[0].metadata.name}')
        if [ -n "$POD_NAME" ]; then
            break
        fi
        echo "Attempt $attempt: Waiting for ${SERVICE_LABEL} pod to be available..." >&2
        sleep $RETRY_INTERVAL
        attempt=$((attempt + 1))
    done

    if [ -z "$POD_NAME" ]; then
        echo "Error: Failed to get ${SERVICE_LABEL} pod name after $MAX_RETRIES attempts" >&2
        return 1
    fi
    echo "Pod name: [${POD_NAME}]" >&2

    # Get node name
    attempt=1
    NODE_NAME=""
    while [ $attempt -le $MAX_RETRIES ]; do
        NODE_NAME=$(kubectl get pod ${POD_NAME} -n ${NAMESPACE} -o jsonpath='{.spec.nodeName}')
        if [ -n "$NODE_NAME" ]; then
            break
        fi
        echo "Attempt $attempt: Waiting for node name to be available..." >&2
        sleep $RETRY_INTERVAL
        attempt=$((attempt + 1))
    done

    if [ -z "$NODE_NAME" ]; then
        echo "Error: Failed to get node name after $MAX_RETRIES attempts" >&2
        return 1
    fi
    echo "Node name: ${NODE_NAME}" >&2

    # Get the node's external IP
    NODE_IP=$(kubectl get node ${NODE_NAME} -o jsonpath='{.status.addresses[?(@.type=="ExternalIP")].address}')
    echo "Node IP: ${NODE_IP}" >&2
    echo "http://${NODE_IP}:${PORT}"
}

# Configure Ethereum address
if [ "${ETHEREUM_EXTERNAL_HOST}" != "" ]; then
    ETHEREUM_ADDR="${ETHEREUM_EXTERNAL_HOST}"
elif [ "${NETWORK_PUBLIC}" = "true" ]; then
    ETHEREUM_ADDR=$(get_service_address "ethereum" "${ETHEREUM_PORT}")
else
    ETHEREUM_ADDR="http://${SERVICE_NAME}-ethereum.${NAMESPACE}:${ETHEREUM_PORT}"
fi

# Configure Boot Node address
if [ "${BOOT_NODE_EXTERNAL_HOST}" != "" ]; then
    BOOT_NODE_ADDR="${BOOT_NODE_EXTERNAL_HOST}"
elif [ "${NETWORK_PUBLIC}" = "true" ]; then
    BOOT_NODE_ADDR=$(get_service_address "boot-node" "${BOOT_NODE_PORT}")
else
    BOOT_NODE_ADDR="http://${SERVICE_NAME}-boot-node.${NAMESPACE}:${BOOT_NODE_PORT}"
fi

# Configure Prover Node address
if [ "${PROVER_NODE_EXTERNAL_HOST}" != "" ]; then
    PROVER_NODE_ADDR="${PROVER_NODE_EXTERNAL_HOST}"
elif [ "${NETWORK_PUBLIC}" = "true" ]; then
    PROVER_NODE_ADDR=$(get_service_address "prover-node" "${PROVER_NODE_PORT}")
else
    PROVER_NODE_ADDR="http://${SERVICE_NAME}-prover-node.${NAMESPACE}:${PROVER_NODE_PORT}"
fi


# Write addresses to file for sourcing
echo "export ETHEREUM_HOST=${ETHEREUM_ADDR}" >> /shared/config/service-addresses
echo "export BOOT_NODE_HOST=${BOOT_NODE_ADDR}" >> /shared/config/service-addresses
echo "export PROVER_NODE_HOST=${PROVER_NODE_ADDR}" >> /shared/config/service-addresses
echo "Addresses configured:"
cat /shared/config/service-addresses
