// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPaymaster {
    function validatePaymasterUserOp(
        bytes calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    ) external returns (bytes memory context, uint256 validationData);

    function postOp(
        uint8 mode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 actualUserOpFeePerGas
    ) external;
}
