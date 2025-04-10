import { ethers } from "hardhat";
import { expect } from "chai";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { Marketplace, CarbonCreditToken, LiquidityProviderToken, ProjectToken } from "../typechain-types";

describe("Marketplace", function () {
    let marketplace: Marketplace;
    let cctToken: CarbonCreditToken;
    let lpToken: LiquidityProviderToken;
    let projectToken: ProjectToken;
    let owner: SignerWithAddress;
    let seller: SignerWithAddress;
    let buyer: SignerWithAddress;
    let provider: SignerWithAddress;
    let auditor: SignerWithAddress;
    const CCT_AMOUNT = ethers.parseEther("50"); // 50 CCT
    const MATIC_AMOUNT = ethers.parseEther("100"); // 100 MATIC
    const FEE_PERCENTAGE = 50n; // 0.5% (50 / 10000)
    const FEE_DENOMINATOR = 10000n;
    const EXCHANGE_RATE = 1n;
    const PROJECT_ID = 1n;

    beforeEach(async function () {
        [owner, seller, buyer, provider, auditor] = await ethers.getSigners();

        const ProjectToken = await ethers.getContractFactory("ProjectToken");
        projectToken = await ProjectToken.deploy(auditor.address);
        await projectToken.waitForDeployment();

        const CarbonCreditToken = await ethers.getContractFactory("CarbonCreditToken");
        cctToken = await CarbonCreditToken.deploy(auditor.address, projectToken.target);
        await cctToken.waitForDeployment();

        const Marketplace = await ethers.getContractFactory("Marketplace");
        marketplace = await Marketplace.deploy(cctToken.target);
        await marketplace.waitForDeployment();

        const LiquidityProviderToken = await ethers.getContractFactory("LiquidityProviderToken");
        lpToken = await LiquidityProviderToken.deploy("Liquidity Provider Token", "LPT", marketplace.target);
        await lpToken.waitForDeployment();

        await marketplace.connect(owner).setLpToken(lpToken.target);

        const block = await ethers.provider.getBlock("latest");
        const currentTimestamp = block!.timestamp;
        const oneYearFromNow = currentTimestamp + 365 * 24 * 60 * 60;

        await projectToken.connect(auditor).mintProjectNFT(
            "ipfs://test-uri",
            "Test Project",
            seller.address,
            CCT_AMOUNT,
            "Test Location",
            currentTimestamp,
            oneYearFromNow,
            "Renewable Energy",
            PROJECT_ID
        );
        await cctToken.connect(auditor).issueCarbonCredits(seller.address, CCT_AMOUNT, oneYearFromNow);
    });

    describe("Deployment", function () {
        it("should set the correct CCT token address", async function () {
            expect(await marketplace.ccToken()).to.equal(cctToken.target);
        });

        it("should set the correct LP token address after setLpToken", async function () {
            expect(await marketplace.lpToken()).to.equal(lpToken.target);
        });

        it("should set the owner correctly", async function () {
            expect(await marketplace.owner()).to.equal(owner.address);
        });
    });

    describe("setLpToken", function () {
        it("should allow owner to set LP token", async function () {
            const newMarketplace = await (await ethers.getContractFactory("Marketplace")).deploy(cctToken.target);
            await newMarketplace.waitForDeployment();
            await newMarketplace.connect(owner).setLpToken(lpToken.target);
            expect(await newMarketplace.lpToken()).to.equal(lpToken.target);
        });

        it("should revert if non-owner tries to set LP token", async function () {
            await expect(marketplace.connect(seller).setLpToken(lpToken.target))
                .to.be.revertedWithCustomError(marketplace, "OwnableUnauthorizedAccount")
                .withArgs(seller.address);
        });

        it("should revert if LP token already set", async function () {
            await expect(marketplace.connect(owner).setLpToken(lpToken.target))
                .to.be.revertedWith("LP token already set");
        });

        it("should revert if setting to zero address", async function () {
            const newMarketplace = await (await ethers.getContractFactory("Marketplace")).deploy(cctToken.target);
            await newMarketplace.waitForDeployment();
            await expect(newMarketplace.connect(owner).setLpToken(ethers.ZeroAddress))
                .to.be.revertedWith("Invalid LP token address");
        });
    });

    describe("addLiquidity", function () {
        it("should allow adding MATIC liquidity and mint LP tokens", async function () {
            await expect(marketplace.connect(provider).addLiquidity({ value: MATIC_AMOUNT }))
                .to.emit(marketplace, "LiquidityAdded")
                .withArgs(provider.address, MATIC_AMOUNT, MATIC_AMOUNT);
            expect(await marketplace.totalLiquidity()).to.equal(MATIC_AMOUNT);
            expect(await lpToken.balanceOf(provider.address)).to.equal(MATIC_AMOUNT);
            expect(await marketplace.getMaticBalance()).to.equal(MATIC_AMOUNT);
        });

        it("should mint proportional LP tokens for subsequent providers", async function () {
            await marketplace.connect(provider).addLiquidity({ value: MATIC_AMOUNT });
            const additionalMatic = MATIC_AMOUNT / 2n; // 50 MATIC
            const expectedLpTokens = (additionalMatic * MATIC_AMOUNT) / MATIC_AMOUNT; // 50 * 100 / 100 = 50 LP

            await marketplace.connect(seller).addLiquidity({ value: additionalMatic });
            expect(await lpToken.balanceOf(seller.address)).to.equal(expectedLpTokens);
            expect(await marketplace.totalLiquidity()).to.equal(MATIC_AMOUNT + additionalMatic);
            expect(await lpToken.totalSupply()).to.equal(MATIC_AMOUNT + expectedLpTokens);
        });

        it("should revert if no MATIC is sent", async function () {
            await expect(marketplace.connect(provider).addLiquidity({ value: 0 }))
                .to.be.revertedWith("Must send MATIC to add liquidity");
        });

        it("should revert if LP token not set", async function () {
            const newMarketplace = await (await ethers.getContractFactory("Marketplace")).deploy(cctToken.target);
            await newMarketplace.waitForDeployment();
            await expect(newMarketplace.connect(provider).addLiquidity({ value: MATIC_AMOUNT }))
                .to.be.revertedWith("LP token not set");
        });
    });

    describe("sellCCT", function () {
        it("should allow selling CCT for MATIC with fee", async function () {
            await marketplace.connect(provider).addLiquidity({ value: MATIC_AMOUNT });
            await cctToken.connect(seller).approve(marketplace.target, CCT_AMOUNT);

            const sellerMaticBefore = await ethers.provider.getBalance(seller.address);
            const tx = await marketplace.connect(seller).sellCCT(CCT_AMOUNT);
            const receipt = await tx.wait();
            const gasUsed = receipt!.gasUsed * tx.gasPrice!;

            const sellerMaticAfter = await ethers.provider.getBalance(seller.address);
            const maticReceived = sellerMaticAfter - sellerMaticBefore + gasUsed;

            const maticAmount = CCT_AMOUNT * EXCHANGE_RATE;
            const expectedFee = (maticAmount * FEE_PERCENTAGE) / FEE_DENOMINATOR;
            const expectedNetMatic = maticAmount - expectedFee;

            expect(await cctToken.balanceOf(seller.address)).to.equal(0);
            expect(await cctToken.balanceOf(marketplace.target)).to.equal(CCT_AMOUNT);
            expect(maticReceived).to.be.closeTo(expectedNetMatic, ethers.parseEther("0.1"));
            expect(await marketplace.totalLiquidity()).to.equal(MATIC_AMOUNT - maticAmount);
            expect(await marketplace.totalFees()).to.equal(expectedFee);

            await expect(tx)
                .to.emit(marketplace, "TokensSold")
                .withArgs(seller.address, CCT_AMOUNT, expectedNetMatic);
        });

        it("should revert if amount is 0", async function () {
            await expect(marketplace.connect(seller).sellCCT(0))
                .to.be.revertedWith("Amount must be greater than 0");
        });

        it("should revert if insufficient MATIC liquidity", async function () {
            await marketplace.connect(provider).addLiquidity({ value: MATIC_AMOUNT });
            const largeAmount = MATIC_AMOUNT + ethers.parseEther("1");
            await cctToken.connect(auditor).issueCarbonCredits(seller.address, largeAmount, (await ethers.provider.getBlock("latest"))!.timestamp + 365 * 24 * 60 * 60);
            await cctToken.connect(seller).approve(marketplace.target, largeAmount);
            await expect(marketplace.connect(seller).sellCCT(largeAmount))
                .to.be.revertedWith("Insufficient MATIC liquidity");
        });

        it("should revert if CCT transfer fails (no approval)", async function () {
            await marketplace.connect(provider).addLiquidity({ value: MATIC_AMOUNT });
            await cctToken.connect(seller).approve(marketplace.target, 0); // No approval

            await expect(marketplace.connect(seller).sellCCT(CCT_AMOUNT))
                .to.be.revertedWithCustomError(cctToken, "ERC20InsufficientAllowance")
                .withArgs(marketplace.target, 0, CCT_AMOUNT);
        });
    });

    describe("buyCCT", function () {
        it("should allow buying CCT with MATIC and apply fee", async function () {
            await marketplace.connect(provider).addLiquidity({ value: MATIC_AMOUNT });
            await cctToken.connect(seller).approve(marketplace.target, CCT_AMOUNT);
            await marketplace.connect(seller).sellCCT(CCT_AMOUNT); // Add CCT to marketplace

            const buyAmount = ethers.parseEther("10");
            const maticAmount = buyAmount * EXCHANGE_RATE;
            const fee = (maticAmount * FEE_PERCENTAGE) / FEE_DENOMINATOR;
            const netMatic = maticAmount - fee;

            const buyerMaticBefore = await ethers.provider.getBalance(buyer.address);
            const tx = await marketplace.connect(buyer).buyCCT(buyAmount, { value: maticAmount });
            const receipt = await tx.wait();
            const gasUsed = receipt!.gasUsed * tx.gasPrice!;

            const buyerMaticAfter = await ethers.provider.getBalance(buyer.address);
            const maticSpent = buyerMaticBefore - buyerMaticAfter - gasUsed;

            expect(await cctToken.balanceOf(buyer.address)).to.equal(buyAmount);
            expect(await marketplace.totalLiquidity()).to.equal(MATIC_AMOUNT - CCT_AMOUNT + netMatic);
            expect(await marketplace.totalFees()).to.be.closeTo((CCT_AMOUNT * FEE_PERCENTAGE / FEE_DENOMINATOR) + fee, ethers.parseEther("0.0001"));
            expect(maticSpent).to.be.closeTo(maticAmount, ethers.parseEther("0.1"));

            await expect(tx)
                .to.emit(marketplace, "TokensBought")
                .withArgs(buyer.address, buyAmount, maticAmount);
        });

        it("should refund excess MATIC", async function () {
            await marketplace.connect(provider).addLiquidity({ value: MATIC_AMOUNT });
            await cctToken.connect(seller).approve(marketplace.target, CCT_AMOUNT);
            await marketplace.connect(seller).sellCCT(CCT_AMOUNT);

            const buyAmount = ethers.parseEther("10");
            const maticAmount = buyAmount * EXCHANGE_RATE;
            const excess = ethers.parseEther("5");
            const totalSent = maticAmount + excess;

            const buyerMaticBefore = await ethers.provider.getBalance(buyer.address);
            const tx = await marketplace.connect(buyer).buyCCT(buyAmount, { value: totalSent });
            const receipt = await tx.wait();
            const gasUsed = receipt!.gasUsed * tx.gasPrice!;

            const buyerMaticAfter = await ethers.provider.getBalance(buyer.address);
            const maticSpent = buyerMaticBefore - buyerMaticAfter - gasUsed;

            expect(maticSpent).to.be.closeTo(maticAmount, ethers.parseEther("0.1"));
            expect(await cctToken.balanceOf(buyer.address)).to.equal(buyAmount);
        });

        it("should revert if insufficient MATIC sent", async function () {
            await marketplace.connect(provider).addLiquidity({ value: MATIC_AMOUNT });
            await cctToken.connect(seller).approve(marketplace.target, CCT_AMOUNT);
            await marketplace.connect(seller).sellCCT(CCT_AMOUNT);

            const buyAmount = ethers.parseEther("10");
            const insufficientMatic = buyAmount - ethers.parseEther("1");
            await expect(marketplace.connect(buyer).buyCCT(buyAmount, { value: insufficientMatic }))
                .to.be.revertedWith("Insufficient MATIC sent");
        });

        it("should revert if insufficient CCT liquidity", async function () {
            await marketplace.connect(provider).addLiquidity({ value: MATIC_AMOUNT });
            const buyAmount = CCT_AMOUNT + ethers.parseEther("1");
            await expect(marketplace.connect(buyer).buyCCT(buyAmount, { value: buyAmount }))
                .to.be.revertedWith("Insufficient CCT liquidity");
        });

        it("should revert if amount is 0", async function () {
            await expect(marketplace.connect(buyer).buyCCT(0, { value: ethers.parseEther("1") }))
                .to.be.revertedWith("Amount must be greater than 0");
        });
    });

    describe("withdrawLiquidity", function () {
        it("should allow withdrawing liquidity with fees", async function () {
            await marketplace.connect(provider).addLiquidity({ value: MATIC_AMOUNT });
            await cctToken.connect(seller).approve(marketplace.target, CCT_AMOUNT);
            await marketplace.connect(seller).sellCCT(CCT_AMOUNT);

            const lpBalance = await lpToken.balanceOf(provider.address);
            const providerMaticBefore = await ethers.provider.getBalance(provider.address);

            const tx = await marketplace.connect(provider).withdrawLiquidity(lpBalance);
            const receipt = await tx.wait();
            const gasUsed = receipt!.gasUsed * tx.gasPrice!;

            const providerMaticAfter = await ethers.provider.getBalance(provider.address);
            const maticWithdrawn = providerMaticAfter - providerMaticBefore + gasUsed;

            const expectedFee = (CCT_AMOUNT * FEE_PERCENTAGE) / FEE_DENOMINATOR;
            const expectedWithdrawal = MATIC_AMOUNT - CCT_AMOUNT + expectedFee;

            expect(maticWithdrawn).to.be.closeTo(expectedWithdrawal, ethers.parseEther("0.1"));
            expect(await lpToken.balanceOf(provider.address)).to.equal(0);
            expect(await marketplace.totalLiquidity()).to.equal(0);
            expect(await marketplace.totalFees()).to.equal(0);

            await expect(tx)
                .to.emit(marketplace, "LiquidityWithdrawn")
                .withArgs(provider.address, expectedWithdrawal, lpBalance);
        });

        it("should revert if no LP tokens provided", async function () {
            await expect(marketplace.connect(provider).withdrawLiquidity(0))
                .to.be.revertedWith("Amount must be greater than 0");
        });

        it("should revert if insufficient LP tokens", async function () {
            await marketplace.connect(provider).addLiquidity({ value: MATIC_AMOUNT });
            const excessAmount = (await lpToken.balanceOf(provider.address)) + 1n;
            await expect(marketplace.connect(provider).withdrawLiquidity(excessAmount))
                .to.be.revertedWith("Insufficient LP tokens");
        });

        it("should revert if insufficient contract balance", async function () {
            await marketplace.connect(provider).addLiquidity({ value: MATIC_AMOUNT });
            const lpBalance = await lpToken.balanceOf(provider.address);
            await ethers.provider.send("hardhat_setBalance", [marketplace.target, "0x0"]);
            await expect(marketplace.connect(provider).withdrawLiquidity(lpBalance))
                .to.be.revertedWith("Insufficient contract balance");
        });
    });

    describe("withdrawCCT", function () {
        it("should allow owner to withdraw CCT", async function () {
            await marketplace.connect(provider).addLiquidity({ value: MATIC_AMOUNT });
            await cctToken.connect(seller).approve(marketplace.target, CCT_AMOUNT);
            await marketplace.connect(seller).sellCCT(CCT_AMOUNT);

            const ownerCCTBefore = await cctToken.balanceOf(owner.address);
            await marketplace.connect(owner).withdrawCCT(CCT_AMOUNT);
            const ownerCCTAfter = await cctToken.balanceOf(owner.address);

            expect(await cctToken.balanceOf(marketplace.target)).to.equal(0);
            expect(ownerCCTAfter - ownerCCTBefore).to.equal(CCT_AMOUNT);
        });

        it("should revert if non-owner tries to withdraw", async function () {
            await marketplace.connect(provider).addLiquidity({ value: MATIC_AMOUNT });
            await cctToken.connect(seller).approve(marketplace.target, CCT_AMOUNT);
            await marketplace.connect(seller).sellCCT(CCT_AMOUNT);

            await expect(marketplace.connect(seller).withdrawCCT(CCT_AMOUNT))
                .to.be.revertedWithCustomError(marketplace, "OwnableUnauthorizedAccount")
                .withArgs(seller.address);
        });

        it("should revert if CCT transfer fails (insufficient balance)", async function () {
            await expect(marketplace.connect(owner).withdrawCCT(CCT_AMOUNT))
                .to.be.revertedWithCustomError(cctToken, "ERC20InsufficientBalance")
                .withArgs(marketplace.target, 0, CCT_AMOUNT);
        });
    });

    describe("getMaticBalance", function () {
        it("should return correct MATIC balance", async function () {
            await marketplace.connect(provider).addLiquidity({ value: MATIC_AMOUNT });
            await cctToken.connect(seller).approve(marketplace.target, CCT_AMOUNT);
            await marketplace.connect(seller).sellCCT(CCT_AMOUNT);

            const expectedBalance = MATIC_AMOUNT - CCT_AMOUNT + (CCT_AMOUNT * FEE_PERCENTAGE) / FEE_DENOMINATOR;
            expect(await marketplace.getMaticBalance()).to.equal(expectedBalance);
        });
    });

    describe("getCCTBalance", function () {
        it("should return correct CCT balance", async function () {
            await marketplace.connect(provider).addLiquidity({ value: MATIC_AMOUNT });
            await cctToken.connect(seller).approve(marketplace.target, CCT_AMOUNT);
            await marketplace.connect(seller).sellCCT(CCT_AMOUNT);

            expect(await marketplace.getCCTBalance()).to.equal(CCT_AMOUNT);
        });
    });

    describe("receive", function () {
        it("should accept MATIC and mint LP tokens", async function () {
            await expect(seller.sendTransaction({ to: marketplace.target, value: MATIC_AMOUNT }))
                .to.emit(marketplace, "LiquidityAdded")
                .withArgs(seller.address, MATIC_AMOUNT, MATIC_AMOUNT);
            expect(await marketplace.getMaticBalance()).to.equal(MATIC_AMOUNT);
            expect(await lpToken.balanceOf(seller.address)).to.equal(MATIC_AMOUNT);
            expect(await marketplace.totalLiquidity()).to.equal(MATIC_AMOUNT);
        });

        it("should revert if no MATIC sent", async function () {
            await expect(seller.sendTransaction({ to: marketplace.target, value: 0 }))
                .to.be.revertedWith("Must send MATIC to add liquidity");
        });

        it("should revert if LP token not set", async function () {
            const newMarketplace = await (await ethers.getContractFactory("Marketplace")).deploy(cctToken.target);
            await newMarketplace.waitForDeployment();
            await expect(seller.sendTransaction({ to: newMarketplace.target, value: MATIC_AMOUNT }))
                .to.be.revertedWith("LP token not set");
        });
    });
});