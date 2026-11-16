import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Fn } from "aws-cdk-lib";

export class VpcStack extends Stack {
  public readonly vpc: ec2.Vpc;
  public readonly vpcCidrString: string;
  public readonly privateSubnetsCidrStrings: string[];

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // --- VPC configuration from CDK context (no source edits needed) ---
    // Deploy with existing VPC:  cdk deploy -c existingVpcId=vpc-0abc123...
    // All keys are optional; defaults preserve current behavior.
    const existingVpcId: string =
      this.node.tryGetContext("existingVpcId") ?? "";

    if (existingVpcId !== "") {
      const AWSControlTowerStackSet: string =
        this.node.tryGetContext("controlTowerStackSet") ??
        "StackSet-AWSControlTowerBP-VPC-ACCOUNT-FACTORY-V1-df80d055-f27d-4b9a-917f-f0db2da2ad91";

      const existingPublicSubnetID: string =
        this.node.tryGetContext("existingPublicSubnetId") ?? "";

      const stackPrefix: string =
        this.node.tryGetContext("StackPrefix") ?? "PIPT-production";

      this.vpcCidrString =
        this.node.tryGetContext("existingVpcCidr") ?? "172.31.128.0/20";

      // Public subnet CIDR — should be a small slice, NOT the whole VPC range.
      // Defaults to vpcCidrString for backward-compat with existing deployments.
      const publicSubnetCidr: string =
        this.node.tryGetContext("publicSubnetCidr") ?? this.vpcCidrString;

      // Availability zones — derive from context or fall back to stack environment
      const azs: string[] =
        this.node.tryGetContext("availabilityZones") ?? this.availabilityZones;

      // VPC for application
      this.vpc = ec2.Vpc.fromVpcAttributes(this, `${id}-Vpc`, {
        vpcId: existingVpcId,
        availabilityZones: azs,
        privateSubnetIds: [
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet1AID`),
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet2AID`),
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet3AID`),
        ],
        privateSubnetRouteTableIds: [
          Fn.importValue(
            `${AWSControlTowerStackSet}-PrivateSubnet1ARouteTable`
          ),
          Fn.importValue(
            `${AWSControlTowerStackSet}-PrivateSubnet2ARouteTable`
          ),
          Fn.importValue(
            `${AWSControlTowerStackSet}-PrivateSubnet3ARouteTable`
          ),
        ],
        vpcCidrBlock: Fn.importValue(`${AWSControlTowerStackSet}-VPCCIDR`),
      }) as ec2.Vpc;

      // Extract CIDR ranges from the private subnets
      this.privateSubnetsCidrStrings = [
        Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet1ACIDR`),
        Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet2ACIDR`),
        Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet3ACIDR`),
      ];

      if (existingPublicSubnetID === "") {
        console.log(
          "No public subnet exists. Creating new public subnet, IGW, and NAT GW."
        );

        // Create a public subnet
        const publicSubnet = new ec2.Subnet(this, `PublicSubnet`, {
          vpcId: this.vpc.vpcId,
          availabilityZone: azs[0],
          cidrBlock: publicSubnetCidr,
          mapPublicIpOnLaunch: true,
        });

        // Create an Internet Gateway and attach it to the VPC
        const internetGateway = new ec2.CfnInternetGateway(
          this,
          `InternetGateway`,
          {}
        );
        new ec2.CfnVPCGatewayAttachment(this, "VPCGatewayAttachment", {
          vpcId: this.vpc.vpcId,
          internetGatewayId: internetGateway.ref,
        });

        // Add a NAT Gateway in the public subnet
        const natGateway = new ec2.CfnNatGateway(this, `NatGateway`, {
          subnetId: publicSubnet.subnetId,
          allocationId: new ec2.CfnEIP(this, "EIP", {}).attrAllocationId,
        });

        // Use the route table associated with the public subnet
        const publicRouteTableId = publicSubnet.routeTable.routeTableId;

        // Add a route to the Internet Gateway in the existing public route table
        new ec2.CfnRoute(this, `PublicRoute`, {
          routeTableId: publicRouteTableId,
          destinationCidrBlock: "0.0.0.0/0",
          gatewayId: internetGateway.ref,
        });

        // Update route table for private subnets
        new ec2.CfnRoute(this, `${stackPrefix}PrivateSubnetRoute1`, {
          routeTableId: this.vpc.privateSubnets[0].routeTable.routeTableId,
          destinationCidrBlock: "0.0.0.0/0",
          natGatewayId: natGateway.ref,
        });

        new ec2.CfnRoute(this, `${stackPrefix}PrivateSubnetRoute2`, {
          routeTableId: this.vpc.privateSubnets[1].routeTable.routeTableId,
          destinationCidrBlock: "0.0.0.0/0",
          natGatewayId: natGateway.ref,
        });

        new ec2.CfnRoute(this, `${stackPrefix}PrivateSubnetRoute3`, {
          routeTableId: this.vpc.privateSubnets[2].routeTable.routeTableId,
          destinationCidrBlock: "0.0.0.0/0",
          natGatewayId: natGateway.ref,
        });
      } else {
        console.log(
          `Public subnet already exists. Skipping creation of public resources.`
        );
      }

      const skipVpcEndpoints: boolean =
        (this.node.tryGetContext("skipVpcEndpoints") ?? false) === true;

      if (!skipVpcEndpoints) {
        // Add interface endpoints for private subnets
        this.vpc.addInterfaceEndpoint("SSM Endpoint", {
          service: ec2.InterfaceVpcEndpointAwsService.SSM,
          subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
          privateDnsEnabled: true, // Enable private DNS for proper resolution
        });

        this.vpc.addInterfaceEndpoint("Secrets Manager Endpoint", {
          service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
          subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
          privateDnsEnabled: true, // Enable private DNS for proper resolution
        });

        // Free gateway endpoint — routes DynamoDB traffic within the AWS backbone instead of through NAT
        this.vpc.addGatewayEndpoint("DynamoDB Endpoint", {
          service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
          subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
        });

        // Free gateway endpoint — routes S3 traffic within the AWS backbone instead of through NAT
        this.vpc.addGatewayEndpoint("S3 Endpoint", {
          service: ec2.GatewayVpcEndpointAwsService.S3,
          subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
        });
      } else {
        console.log("Skipping VPC endpoint creation — endpoints already exist on this VPC.");
      }

      this.vpc.addFlowLog(`${id}-vpcFlowLog`);


    } else {
      this.vpcCidrString =
        this.node.tryGetContext("vpcCidr") ?? "10.0.0.0/16";
      const maxAzs: number =
        this.node.tryGetContext("maxAzs") ?? 2;
      const natGateways: number =
        this.node.tryGetContext("natGateways") ?? 1;

    // REVIEW: A single NAT Gateway is a single point of failure. If the AZ hosting the NAT GW
    // goes down, all private-subnet Lambda functions and ECS tasks lose internet access.
    // For production, consider natGateways: 2 (one per AZ) for high availability.
    // Cost trade-off: ~$32/month per NAT GW + data processing charges.
    const natGatewayProvider = ec2.NatProvider.gateway();

      // VPC for application
      this.vpc = new ec2.Vpc(this, `${id}-Vpc`, {
        ipAddresses: ec2.IpAddresses.cidr(this.vpcCidrString),
        natGatewayProvider: natGatewayProvider,
        natGateways: natGateways,
        maxAzs: maxAzs,
        subnetConfiguration: [
          {
            name: "public-subnet-1",
            subnetType: ec2.SubnetType.PUBLIC,
          },
          {
            name: "private-subnet-1",
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          },
          {
            name: "isolated-subnet-1",
            subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          },
        ],
      });

      this.exportValue(this.vpc.vpcCidrBlock);

      this.vpc.addFlowLog(`${id}-vpcFlowLog`);

      // Populate private subnet CIDRs for downstream security-group rules (e.g., DatabaseStack)
      this.privateSubnetsCidrStrings = this.vpc.privateSubnets.map(s => s.ipv4CidrBlock);

      // Add secrets manager endpoint to VPC
      this.vpc.addInterfaceEndpoint(`${id}-Secrets Manager Endpoint`, {
        service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      });

      this.vpc.addInterfaceEndpoint(`${id}-SSM Endpoint`, {
        service: ec2.InterfaceVpcEndpointAwsService.SSM,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        privateDnsEnabled: true,
      });

      // Free gateway endpoint — routes DynamoDB traffic within the AWS backbone instead of through NAT
      this.vpc.addGatewayEndpoint(`${id}-DynamoDB Endpoint`, {
        service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
        subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      });

      // Free gateway endpoint — routes S3 traffic within the AWS backbone instead of through NAT
      this.vpc.addGatewayEndpoint(`${id}-S3 Endpoint`, {
        service: ec2.GatewayVpcEndpointAwsService.S3,
        subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      });
    }
  }
}
