import { expect } from "chai";
import { ethers } from "hardhat";
import { AgentGatePaymaster, PublisherRegistry } from "../typechain-types";

async function deployEntryPoint(): Promise<string> {
  // Deploy the real EntryPoint v0.7 — BasePaymaster validates its interface in the constructor.
  // contracts/test/EntryPointImport.sol forces Hardhat to compile it so this lookup works.
  const EPFactory = await ethers.getContractFactory("EntryPoint");
  const ep = await EPFactory.deploy();
  await ep.waitForDeployment();
  return await ep.getAddress();
}

describe("AgentGatePaymaster", function () {
  let paymaster: AgentGatePaymaster;
  let owner: any;
  let publisher: any;
  let other: any;
  let mockEntryPoint: string;

  beforeEach(async function () {
    [owner, publisher, other] = await ethers.getSigners();

    mockEntryPoint = await deployEntryPoint();

    const PaymasterFactory = await ethers.getContractFactory("AgentGatePaymaster");
    paymaster = await PaymasterFactory.deploy(mockEntryPoint); // single arg: IEntryPoint
    await paymaster.waitForDeployment();
  });

  describe("Deployment", function () {
    it("should set the correct owner", async function () {
      expect(await paymaster.owner()).to.equal(owner.address);
    });

    it("should start with zero totalSponsored", async function () {
      expect(await paymaster.getTotalSponsored()).to.equal(0);
    });

    it("should start with zero totalCalls", async function () {
      expect(await paymaster.totalCalls()).to.equal(0);
    });
  });

  describe("fundAndSetGasShare", function () {
    const url = "https://agentgate.demo/api/weather";

    it("should record depositor as endpoint owner", async function () {
      const hash = ethers.keccak256(ethers.toUtf8Bytes(url));
      await paymaster.connect(publisher).fundAndSetGasShare(url, 10000, {
        value: ethers.parseEther("0.01"),
      });
      expect(await paymaster.endpointOwner(hash)).to.equal(publisher.address);
    });

    it("should credit endpointBalance", async function () {
      const hash     = ethers.keccak256(ethers.toUtf8Bytes(url));
      const deposit  = ethers.parseEther("0.01");
      await paymaster.connect(publisher).fundAndSetGasShare(url, 5000, { value: deposit });
      expect(await paymaster.endpointBalance(hash)).to.equal(deposit);
    });

    it("should persist the bps and mark isSet", async function () {
      const hash = ethers.keccak256(ethers.toUtf8Bytes(url));
      await paymaster.connect(publisher).fundAndSetGasShare(url, 7500, {
        value: ethers.parseEther("0.005"),
      });
      expect(await paymaster.endpointGasShareBps(hash)).to.equal(7500);
      expect(await paymaster.endpointGasShareIsSet(hash)).to.equal(true);
    });

    it("should emit EndpointFunded and EndpointGasShareSet", async function () {
      const hash = ethers.keccak256(ethers.toUtf8Bytes(url));
      const tx   = paymaster.connect(publisher).fundAndSetGasShare(url, 10000, {
        value: ethers.parseEther("0.005"),
      });
      await expect(tx).to.emit(paymaster, "EndpointFunded").withArgs(hash, publisher.address, ethers.parseEther("0.005"));
      await expect(tx).to.emit(paymaster, "EndpointGasShareSet").withArgs(hash, 10000);
    });

    it("should reject second depositor trying to change ownership", async function () {
      await paymaster.connect(publisher).fundAndSetGasShare(url, 10000, {
        value: ethers.parseEther("0.005"),
      });
      await expect(
        paymaster.connect(other).fundAndSetGasShare(url, 5000, { value: ethers.parseEther("0.001") })
      ).to.be.revertedWith("Not endpoint owner");
    });

    it("should reject zero-value deposit", async function () {
      await expect(
        paymaster.connect(publisher).fundAndSetGasShare(url, 10000, { value: 0 })
      ).to.be.revertedWith("No ETH sent");
    });
  });

  describe("setGasShare", function () {
    const url  = "https://agentgate.demo/api/weather";
    const hash = ethers.keccak256(ethers.toUtf8Bytes(url));

    beforeEach(async function () {
      await paymaster.connect(publisher).fundAndSetGasShare(url, 10000, {
        value: ethers.parseEther("0.01"),
      });
    });

    it("should allow owner to update share", async function () {
      await paymaster.connect(publisher).setGasShare(url, 5000);
      expect(await paymaster.endpointGasShareBps(hash)).to.equal(5000);
    });

    it("should mark isSet even when setting to 0 (no sponsorship)", async function () {
      await paymaster.connect(publisher).setGasShare(url, 0);
      expect(await paymaster.endpointGasShareBps(hash)).to.equal(0);
      expect(await paymaster.endpointGasShareIsSet(hash)).to.equal(true);
    });

    it("should reject bps > 10000", async function () {
      await expect(paymaster.connect(publisher).setGasShare(url, 10001)).to.be.revertedWith("bps > 10000");
    });

    it("should reject update from non-owner", async function () {
      await expect(paymaster.connect(other).setGasShare(url, 5000)).to.be.revertedWith("Not endpoint owner");
    });
  });

  describe("withdrawEndpointBalance", function () {
    const url = "https://agentgate.demo/api/withdraw-test";

    beforeEach(async function () {
      await paymaster.connect(publisher).fundAndSetGasShare(url, 10000, {
        value: ethers.parseEther("0.01"),
      });
    });

    it("should allow the depositor (endpointOwner) to withdraw", async function () {
      const hash = ethers.keccak256(ethers.toUtf8Bytes(url));
      // Balance is zeroed after withdrawal even if EntryPoint withdrawTo no-ops
      await paymaster.connect(publisher).withdrawEndpointBalance(url, publisher.address);
      expect(await paymaster.endpointBalance(hash)).to.equal(0);
    });

    it("should reject withdrawal by contract owner if they are not the depositor", async function () {
      // owner !== publisher in this test — should be rejected
      if ((await paymaster.owner()) === publisher.address) return; // skip if same signer
      await expect(
        paymaster.connect(owner).withdrawEndpointBalance(url, owner.address)
      ).to.be.revertedWith("Not endpoint owner");
    });

    it("should reject withdrawal by random third party", async function () {
      await expect(
        paymaster.connect(other).withdrawEndpointBalance(url, other.address)
      ).to.be.revertedWith("Not endpoint owner");
    });

    it("should reject withdrawal when balance is zero", async function () {
      await paymaster.connect(publisher).withdrawEndpointBalance(url, publisher.address);
      await expect(
        paymaster.connect(publisher).withdrawEndpointBalance(url, publisher.address)
      ).to.be.revertedWith("No balance");
    });
  });
});

describe("PublisherRegistry", function () {
  let registry: PublisherRegistry;
  let publisher: any;
  let other: any;

  beforeEach(async function () {
    [publisher, other] = await ethers.getSigners();

    const RegistryFactory = await ethers.getContractFactory("PublisherRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();
  });

  describe("Endpoint Registration", function () {
    it("should register an endpoint and emit event", async function () {
      const url      = "https://api.example.com/weather";
      const price    = 10000;
      const paymaster = ethers.ZeroAddress;

      await expect(registry.registerEndpoint(url, price, paymaster))
        .to.emit(registry, "EndpointRegistered")
        .withArgs(0, publisher.address, url, price, paymaster);
    });

    it("should return correct endpoint data", async function () {
      const url = "https://api.example.com/prices";
      await registry.registerEndpoint(url, 5000, ethers.ZeroAddress);

      const endpoint = await registry.getEndpoint(0);
      expect(endpoint.url).to.equal(url);
      expect(endpoint.pricePerCall).to.equal(5000);
      expect(endpoint.isActive).to.equal(true);
      expect(endpoint.publisher).to.equal(publisher.address);
    });

    it("should track publisher endpoints", async function () {
      await registry.registerEndpoint("https://api.example.com/a", 1000, ethers.ZeroAddress);
      await registry.registerEndpoint("https://api.example.com/b", 2000, ethers.ZeroAddress);

      const ids = await registry.getPublisherEndpoints(publisher.address);
      expect(ids.length).to.equal(2);
      expect(ids[0]).to.equal(0);
      expect(ids[1]).to.equal(1);
    });

    it("should increment endpoint ID", async function () {
      await registry.registerEndpoint("https://api.example.com/1", 1000, ethers.ZeroAddress);
      await registry.registerEndpoint("https://api.example.com/2", 1000, ethers.ZeroAddress);
      expect(await registry.getTotalEndpoints()).to.equal(2);
    });
  });

  describe("Endpoint Management", function () {
    beforeEach(async function () {
      await registry.registerEndpoint("https://api.example.com/test", 1000, ethers.ZeroAddress);
    });

    it("should deactivate an endpoint", async function () {
      await expect(registry.deactivateEndpoint(0))
        .to.emit(registry, "EndpointDeactivated")
        .withArgs(0, publisher.address);

      const endpoint = await registry.getEndpoint(0);
      expect(endpoint.isActive).to.equal(false);
    });

    it("should reactivate an endpoint", async function () {
      await registry.deactivateEndpoint(0);
      await expect(registry.activateEndpoint(0))
        .to.emit(registry, "EndpointActivated");

      const endpoint = await registry.getEndpoint(0);
      expect(endpoint.isActive).to.equal(true);
    });

    it("should reject deactivation by non-publisher", async function () {
      await expect(
        registry.connect(other).deactivateEndpoint(0)
      ).to.be.revertedWith("Not endpoint publisher");
    });

    it("should update paymaster address", async function () {
      await registry.updatePaymaster(0, other.address);
      const endpoint = await registry.getEndpoint(0);
      expect(endpoint.paymasterAddress).to.equal(other.address);
    });

    it("should check sponsored status", async function () {
      expect(await registry.isSponsored(0)).to.equal(false);
      await registry.updatePaymaster(0, other.address);
      expect(await registry.isSponsored(0)).to.equal(true);
    });
  });

  describe("Call Recording (access-controlled)", function () {
    beforeEach(async function () {
      await registry.registerEndpoint("https://api.example.com/test", 1000, ethers.ZeroAddress);
    });

    it("owner can record a call", async function () {
      await registry.connect(publisher).recordCall(0); // publisher is owner in this test
      const endpoint = await registry.getEndpoint(0);
      expect(endpoint.totalCalls).to.equal(1);
      expect(endpoint.totalRevenue).to.equal(1000);
    });

    it("trustedCaller can record a call after being set", async function () {
      await registry.connect(publisher).setTrustedCaller(other.address);
      await registry.connect(other).recordCall(0);
      const endpoint = await registry.getEndpoint(0);
      expect(endpoint.totalCalls).to.equal(1);
    });

    it("unauthorized address cannot record a call", async function () {
      await expect(
        registry.connect(other).recordCall(0)
      ).to.be.revertedWith("recordCall: not authorized");
    });

    it("should reject call recording for inactive endpoint", async function () {
      await registry.deactivateEndpoint(0);
      await expect(registry.connect(publisher).recordCall(0)).to.be.revertedWith("Endpoint inactive");
    });
  });
});
