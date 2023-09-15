#!/bin/bash

helm uninstall raycluster

helm uninstall kuberay-operator

helm repo remove kuberay

rm ray-cluster-config.yaml

kubectl delete -f ray-spot.yaml
rm ray-spot.yaml
kubectl delete -f ray-on-demand.yaml
rm ray-on-demand.yaml