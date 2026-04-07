// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Importing EntryPoint here causes Hardhat to compile it so tests can use
// ethers.getContractFactory("EntryPoint") without any extra config.
import "@account-abstraction/contracts/core/EntryPoint.sol";
