#!/bin/bash

export AWS_PARTITION="aws" # if you are not using standard partitions, you may need to configure to aws-cn / aws-us-gov
export KARPENTER_VERSION=v0.30.0
export CLUSTER_NAME="${AWS_EKS_CLUSTER}"
export AWS_DEFAULT_REGION="${AWS_REGION}"
export AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID}"
export TEMPOUT=$(mktemp)

curl -fsSL https://raw.githubusercontent.com/tchangkiat/aws-cdk-stacks/main/assets/karpenter.yaml  > $TEMPOUT \
&& aws cloudformation deploy \
  --stack-name "Karpenter-${CLUSTER_NAME}" \
  --template-file "${TEMPOUT}" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides "ClusterName=${CLUSTER_NAME}" \
  --region "${AWS_DEFAULT_REGION}"

eksctl create iamidentitymapping \
  --username system:node:{{EC2PrivateDNSName}} \
  --cluster "${CLUSTER_NAME}" \
  --region "${AWS_DEFAULT_REGION}" \
  --arn "arn:${AWS_PARTITION}:iam::${AWS_ACCOUNT_ID}:role/KarpenterNodeRole-${CLUSTER_NAME}" \
  --group system:bootstrappers \
  --group system:nodes

eksctl utils associate-iam-oidc-provider \
  --region $AWS_REGION \
  --cluster $CLUSTER_NAME \
  --region $AWS_DEFAULT_REGION \
  --approve

eksctl create iamserviceaccount \
  --cluster "${CLUSTER_NAME}" --name karpenter --namespace karpenter \
  --region "${AWS_DEFAULT_REGION}" \
  --role-name "${CLUSTER_NAME}-karpenter" \
  --attach-policy-arn "arn:${AWS_PARTITION}:iam::${AWS_ACCOUNT_ID}:policy/KarpenterControllerPolicy-${CLUSTER_NAME}" \
  --role-only \
  --approve

export KARPENTER_IAM_ROLE_ARN="arn:${AWS_PARTITION}:iam::${AWS_ACCOUNT_ID}:role/${CLUSTER_NAME}-karpenter"

aws iam create-service-linked-role --aws-service-name spot.amazonaws.com || true
# If the role has already been successfully created, you will see:
# An error occurred (InvalidInput) when calling the CreateServiceLinkedRole operation: Service role name AWSServiceRoleForEC2Spot has been taken in this account, please try a different suffix.

helm upgrade --install karpenter oci://public.ecr.aws/karpenter/karpenter --version ${KARPENTER_VERSION} --namespace karpenter --create-namespace \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=${KARPENTER_IAM_ROLE_ARN} \
  --set settings.aws.clusterName=${CLUSTER_NAME} \
  --set settings.aws.defaultInstanceProfile=KarpenterNodeInstanceProfile-${CLUSTER_NAME} \
  --set settings.aws.interruptionQueueName=${CLUSTER_NAME} \
  --set controller.resources.requests.cpu=1 \
  --set controller.resources.requests.memory=1Gi \
  --set controller.resources.limits.cpu=1 \
  --set controller.resources.limits.memory=1Gi \
  --wait

cat <<EOF >>default-provisioner.yaml
apiVersion: karpenter.sh/v1alpha5
kind: Provisioner
metadata:
  name: default
spec:
  requirements:
    - key: "kubernetes.io/arch"
      operator: In
      values: ["amd64"]
    - key: "karpenter.sh/capacity-type"
      operator: In
      values: ["spot", "on-demand"]
    - key: "karpenter.k8s.aws/instance-generation"
      operator: Gt
      values: ["3"]
  limits:
    resources:
      cpu: 30
  providerRef:
    name: default
  consolidation: 
    enabled: true
  ttlSecondsUntilExpired: 2592000
---
apiVersion: karpenter.k8s.aws/v1alpha1
kind: AWSNodeTemplate
metadata:
  name: default
spec:
  amiFamily: "Bottlerocket"
  subnetSelector:
    karpenter.sh/discovery: ${CLUSTER_NAME}
  securityGroupSelector:
    "aws:eks:cluster-name": ${CLUSTER_NAME}
  tags:
    Name: ${CLUSTER_NAME}/karpenter/default
    eks-cost-cluster: ${CLUSTER_NAME}
    eks-cost-workload: Proof-of-Concept
    eks-cost-team: tck
EOF

kubectl apply -f default-provisioner.yaml