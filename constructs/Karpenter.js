const { Aws } = require("aws-cdk-lib");
const {
  CfnInstanceProfile,
  ManagedPolicy,
  Policy,
  PolicyStatement,
  Role,
  ServicePrincipal,
} = require("aws-cdk-lib/aws-iam");
const { Construct } = require("constructs");

class Karpenter extends Construct {
  constructor(scope, id, props) {
    super(scope, id);

    this.cluster = props.cluster;
    this.namespace = props.namespace ?? "karpenter";
    this.version = props.version;

    /*
     * We create a node role for Karpenter managed nodes, alongside an instance profile for the EC2
     * instances that will be managed by karpenter.
     *
     * We will also create a role mapping in the `aws-auth` ConfigMap so that the nodes can authenticate
     * with the Kubernetes API using IAM.
     */
    this.nodeRole = new Role(this, "NodeRole", {
      assumedBy: new ServicePrincipal(`ec2.${Aws.URL_SUFFIX}`),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("AmazonEKS_CNI_Policy"),
        ManagedPolicy.fromAwsManagedPolicyName("AmazonEKSWorkerNodePolicy"),
        ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonEC2ContainerRegistryReadOnly"
        ),
        ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
        ManagedPolicy.fromAwsManagedPolicyName("CloudWatchAgentServerPolicy"),
      ],
      roleName: this.cluster.clusterName + "-karpenter-node",
    });

    const instanceProfile = new CfnInstanceProfile(this, "InstanceProfile", {
      roles: [this.nodeRole.roleName],
      instanceProfileName: `${this.cluster.clusterName}`, // Must be specified to avoid CFN error
    });

    this.cluster.awsAuth.addRoleMapping(this.nodeRole, {
      username: "system:node:{{EC2PrivateDNSName}}",
      groups: ["system:bootstrappers", "system:nodes"],
    });

    /**
     * For the Karpenter controller to be able to talk to the AWS APIs, we need to set up a few
     * resources which will allow the Karpenter controller to use IAM Roles for Service Accounts
     */
    const namespace = this.cluster.addManifest("namespace", {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: this.namespace,
      },
    });

    const serviceAccount = this.cluster.addServiceAccount("karpenter", {
      namespace: this.namespace,
    });
    serviceAccount.node.addDependency(namespace);

    new Policy(this, "ControllerPolicy", {
      roles: [serviceAccount.role],
      statements: [
        new PolicyStatement({
          actions: [
            "ec2:CreateLaunchTemplate",
            "ec2:DeleteLaunchTemplate",
            "ec2:CreateFleet",
            "ec2:RunInstances",
            "ec2:CreateTags",
            "iam:PassRole",
            "ec2:TerminateInstances",
            "ec2:DescribeLaunchTemplates",
            "ec2:DescribeInstances",
            "ec2:DescribeSecurityGroups",
            "ec2:DescribeSubnets",
            "ec2:DescribeInstanceTypes",
            "ec2:DescribeInstanceTypeOfferings",
            "ec2:DescribeAvailabilityZones",
            "ssm:GetParameter",
          ],
          resources: ["*"],
        }),
      ],
    });

    this.chart = this.cluster.addHelmChart("karpenter", {
      // This one is important, if we don't ask helm to wait for resources to become available, the
      // subsequent creation of karpenter resources will fail.
      wait: true,
      chart: "karpenter",
      release: "karpenter",
      repository: "https://charts.karpenter.sh",
      namespace: this.namespace,
      version: this.version ?? undefined,
      createNamespace: false,
      values: {
        serviceAccount: {
          create: false,
          name: serviceAccount.serviceAccountName,
          annotations: {
            "eks.amazonaws.com/role-arn": serviceAccount.role.roleArn,
          },
        },
        clusterName: this.cluster.clusterName,
        clusterEndpoint: this.cluster.clusterEndpoint,
        aws: {
          defaultInstanceProfile: instanceProfile.ref,
        },
      },
    });
    this.chart.node.addDependency(namespace);
  }

  /**
   * addProvisioner adds a provisioner manifest to the cluster. Currently the provisioner spec
   * parameter is relatively free form.
   *
   * @param id - must consist of lower case alphanumeric characters, \'-\' or \'.\', and must start and end with an alphanumeric character
   * @param provisionerSpec - spec of Karpenters Provisioner object.
   */
  addProvisioner(id, provisionerSpec) {
    let m = {
      apiVersion: "karpenter.sh/v1alpha5",
      kind: "Provisioner",
      metadata: {
        name: id,
        namespace: this.namespace,
      },
      spec: {},
    };
    m.spec = provisionerSpec;
    let provisioner = this.cluster.addManifest(id, m);
    provisioner.node.addDependency(this.chart);
  }
}

module.exports = { Karpenter };
