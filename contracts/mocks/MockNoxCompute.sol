// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {INoxCompute} from "@iexec-nox/nox-protocol-contracts/contracts/interfaces/INoxCompute.sol";
import {TEEType} from "@iexec-nox/nox-protocol-contracts/contracts/utils/TypeUtils.sol";

/// @title MockNoxCompute
/// @notice A plaintext, fully local stand-in for the NoxCompute singleton.
///
/// ## Why this exists
///
/// The Nox Hardhat plugin boots the real offchain stack (Handle Gateway, Runner,
/// KMS, Ingestor) over Docker Compose. Without Docker there is no way to execute
/// a single confidential op locally, which would force every iteration of the
/// netting logic through a Sepolia round-trip (build.md F9).
///
/// This contract implements the same `INoxCompute` interface with plaintext
/// arithmetic and a real ACL, and is etched at the local NoxCompute address
/// (`0x75C6AF4430cc474b1bb9b8540b7E46D6f8e1C685`, chain 31337) by the test
/// harness. `Nox.sol` is then fully functional locally: every `Nox.add`,
/// `Nox.select`, `Nox.safeSub` resolves against this contract instead of a TEE.
///
/// The result is a fast local loop for logic and invariants, with the real
/// encrypted path verified separately on Sepolia.
///
/// ## What this mock CANNOT tell you
///
/// Treat a green local run as evidence about *logic*, never about privacy or
/// performance. Specifically it does not model:
///
///   1. **Confidentiality.** Values are stored in plain storage and are trivially
///      readable. Privacy claims (invariant I5) are only meaningful on Sepolia.
///   2. **Gas.** Real Nox ops are external calls into an attested system; costs
///      here are unrepresentative. The op *counts* transfer, the gas does not.
///      Build.md §2.6's batch-size limit must still be measured for real.
///   3. **Async handle resolution.** Here every op resolves in the same
///      transaction. On the real system the Runner computes off-chain
///      afterwards, which is the entire content of build.md F3. The keeper's
///      polling logic is therefore UNTESTED by this mock and must be exercised
///      on Sepolia before the demo.
///   4. **Proof verification.** `validateInputProof` accepts anything and
///      `validateDecryptionProof` skips signature checking, so invariant I7
///      ("the keeper cannot lie") is NOT proven locally.
///
/// Faithfully modelled, deliberately: **transient ACL semantics**. Transient
/// grants are cleared at end-of-transaction exactly as on the real system, so
/// the single most common Nox bug — forgetting `Nox.allowThis` after an op
/// (build.md §8, trap 2) — does reproduce here. That is most of this mock's
/// value as a correctness tool.
contract MockNoxCompute is INoxCompute {
    /// @dev Bit 0 of the attrs byte, matching HandleUtils.ATTR_IS_UNIQUE_HANDLE.
    bytes1 private constant ATTR_IS_UNIQUE_HANDLE = 0x01;

    /// @dev handle => plaintext. An unregistered handle reads as 0, which is
    ///      exactly right: `HandleUtils.zeroHandle(type)` is computed purely
    ///      off-contract and never registered, and must behave as encrypted 0.
    mapping(bytes32 => uint256) private _values;

    mapping(bytes32 => mapping(address => bool)) private _admins;
    mapping(bytes32 => mapping(address => bool)) private _viewers;
    mapping(bytes32 => bool) private _publiclyDecryptable;

    uint256 private _nonce;

    bytes private _kmsPublicKey;
    address private _gateway;
    uint256 private _proofExpirationDuration = 1 days;

    // ---------------------------------------------------------------- handles

    function _newHandle(TEEType teeType, uint256 value) private returns (bytes32 h) {
        unchecked {
            _nonce++;
        }
        h = _pack(teeType, _nonce, true);
        _values[h] = value;
        _admins[h][msg.sender] = true;
        _tSet(h, msg.sender, true);
    }

    /// @dev Handle layout, mirroring HandleUtils:
    ///      [0] version | [1-4] chainId | [5] type | [6] attrs | [7-31] pre-handle
    function _pack(TEEType teeType, uint256 pre, bool unique) private view returns (bytes32 h) {
        h = bytes32(bytes4(uint32(block.chainid))) >> 8;
        h |= bytes32(bytes1(uint8(teeType))) >> (5 * 8);
        if (unique) h |= bytes32(ATTR_IS_UNIQUE_HANDLE) >> (6 * 8);
        // Low 200 bits = bytes 7..31.
        h |= bytes32(pre & ((uint256(1) << 200) - 1));
    }

    function _isPublic(bytes32 handle) private pure returns (bool) {
        return (handle[6] & ATTR_IS_UNIQUE_HANDLE) == 0;
    }

    // ------------------------------------------------------- transient grants
    //
    // Solidity rejects `transient` on mappings ("Transient data location is only
    // supported for value types"), so transient ACL state is kept in raw
    // transient storage via tstore/tload at a hashed slot. This is not a detail
    // worth skipping: EVM transient storage is wiped at end-of-transaction, which
    // is what reproduces the real system's semantics and lets local tests catch a
    // missing `Nox.allowThis` (build.md §8, trap 2).

    function _tSlot(bytes32 handle, address account) private pure returns (bytes32) {
        return keccak256(abi.encode("MockNoxCompute.transient", handle, account));
    }

    function _tGet(bytes32 handle, address account) private view returns (bool v) {
        bytes32 s = _tSlot(handle, account);
        assembly ("memory-safe") {
            v := tload(s)
        }
    }

    function _tSet(bytes32 handle, address account, bool v) private {
        bytes32 s = _tSlot(handle, account);
        assembly ("memory-safe") {
            tstore(s, v)
        }
    }

    function _get(bytes32 handle) private view returns (uint256) {
        return _values[handle];
    }

    function _bool(bool v) private returns (bytes32) {
        return _newHandle(TEEType.Bool, v ? 1 : 0);
    }

    /// @dev Every arithmetic result is a Uint256 handle. The mock does not model
    ///      per-width wrapping; widths are carried by the handle's type byte only.
    function _uint(uint256 v) private returns (bytes32) {
        return _newHandle(TEEType.Uint256, v);
    }

    // ------------------------------------------------------------------- ACL

    function allow(bytes32 handle, address account) external {
        if (account == address(0)) revert InvalidZeroAddress();
        if (_isPublic(handle)) revert PublicHandleACLForbidden();
        if (!_hasAccess(handle, msg.sender)) revert UnauthorizedSender(msg.sender);
        _admins[handle][account] = true;
        emit Allowed(msg.sender, account, handle);
    }

    function allowTransient(bytes32 handle, address account) external {
        if (account == address(0)) revert InvalidZeroAddress();
        if (_isPublic(handle)) return;
        if (!_hasAccess(handle, msg.sender)) revert UnauthorizedSender(msg.sender);
        _tSet(handle, account, true);
    }

    function disallowTransient(bytes32 handle, address account) external {
        _tSet(handle, account, false);
    }

    function _hasAccess(bytes32 handle, address account) private view returns (bool) {
        if (_isPublic(handle)) return true;
        return _admins[handle][account] || _tGet(handle, account);
    }

    function isAllowed(bytes32 handle, address account) external view returns (bool) {
        return _hasAccess(handle, account);
    }

    function validateAllowedForAll(address account, bytes32[] calldata handles) external view {
        for (uint256 i = 0; i < handles.length; i++) {
            if (!_hasAccess(handles[i], account)) revert NotAllowed(handles[i], account);
        }
    }

    function addViewer(bytes32 handle, address viewer) external {
        if (viewer == address(0)) revert InvalidZeroAddress();
        if (_isPublic(handle)) revert PublicHandleACLForbidden();
        if (!_hasAccess(handle, msg.sender)) revert UnauthorizedSender(msg.sender);
        _viewers[handle][viewer] = true;
        emit ViewerAdded(msg.sender, viewer, handle);
    }

    function isViewer(bytes32 handle, address viewer) external view returns (bool) {
        if (_isPublic(handle)) return true;
        return _publiclyDecryptable[handle] || _viewers[handle][viewer] || _admins[handle][viewer];
    }

    function allowPublicDecryption(bytes32 handle) external {
        if (_isPublic(handle)) return;
        if (!_hasAccess(handle, msg.sender)) revert UnauthorizedSender(msg.sender);
        _publiclyDecryptable[handle] = true;
        emit MarkedAsPubliclyDecryptable(msg.sender, handle);
    }

    function isPubliclyDecryptable(bytes32 handle) external view returns (bool) {
        return _isPublic(handle) || _publiclyDecryptable[handle];
    }

    // --------------------------------------------------------------- compute

    function wrapAsPublicHandle(bytes32 value, TEEType teeType) external returns (bytes32 h) {
        // Deterministic: same (value, type) always yields the same handle, and
        // the unique bit stays unset so it is treated as public everywhere.
        h = _pack(teeType, uint256(keccak256(abi.encode(value, teeType))), false);
        _values[h] = uint256(value);
        emit WrapAsPublicHandle(msg.sender, value, teeType, h);
    }

    function add(bytes32 a, bytes32 b) external returns (bytes32 r) {
        unchecked {
            r = _uint(_get(a) + _get(b));
        }
        emit Add(msg.sender, a, b, r);
    }

    function sub(bytes32 a, bytes32 b) external returns (bytes32 r) {
        unchecked {
            r = _uint(_get(a) - _get(b));
        }
        emit Sub(msg.sender, a, b, r);
    }

    function mul(bytes32 a, bytes32 b) external returns (bytes32 r) {
        unchecked {
            r = _uint(_get(a) * _get(b));
        }
        emit Mul(msg.sender, a, b, r);
    }

    /// @dev Matches the documented behaviour of the real system: division by zero
    ///      yields encrypted MAX_UINT rather than reverting. Silently wrong, not
    ///      a revert — which is precisely why callers should prefer `safeDiv`.
    function div(bytes32 n, bytes32 d) external returns (bytes32 r) {
        uint256 dv = _get(d);
        r = _uint(dv == 0 ? type(uint256).max : _get(n) / dv);
        emit Div(msg.sender, n, d, r);
    }

    function safeAdd(bytes32 a, bytes32 b) external returns (bytes32 ok, bytes32 r) {
        uint256 av = _get(a);
        uint256 bv = _get(b);
        unchecked {
            uint256 s = av + bv;
            bool good = s >= av;
            ok = _bool(good);
            r = _uint(good ? s : 0);
        }
        emit SafeAdd(msg.sender, a, b, ok, r);
    }

    function safeSub(bytes32 a, bytes32 b) external returns (bytes32 ok, bytes32 r) {
        uint256 av = _get(a);
        uint256 bv = _get(b);
        bool good = av >= bv;
        ok = _bool(good);
        r = _uint(good ? av - bv : 0);
        emit SafeSub(msg.sender, a, b, ok, r);
    }

    function safeMul(bytes32 a, bytes32 b) external returns (bytes32 ok, bytes32 r) {
        uint256 av = _get(a);
        uint256 bv = _get(b);
        unchecked {
            uint256 p = av * bv;
            bool good = av == 0 || p / av == bv;
            ok = _bool(good);
            r = _uint(good ? p : 0);
        }
        emit SafeMul(msg.sender, a, b, ok, r);
    }

    function safeDiv(bytes32 n, bytes32 d) external returns (bytes32 ok, bytes32 r) {
        uint256 dv = _get(d);
        bool good = dv != 0;
        ok = _bool(good);
        r = _uint(good ? _get(n) / dv : 0);
        emit SafeDiv(msg.sender, n, d, ok, r);
    }

    function select(bytes32 c, bytes32 t, bytes32 f) external returns (bytes32 r) {
        r = _uint(_get(c) != 0 ? _get(t) : _get(f));
        emit Select(msg.sender, c, t, f, r);
    }

    function eq(bytes32 a, bytes32 b) external returns (bytes32 r) {
        r = _bool(_get(a) == _get(b));
        emit Eq(msg.sender, a, b, r);
    }

    function ne(bytes32 a, bytes32 b) external returns (bytes32 r) {
        r = _bool(_get(a) != _get(b));
        emit Ne(msg.sender, a, b, r);
    }

    function lt(bytes32 a, bytes32 b) external returns (bytes32 r) {
        r = _bool(_get(a) < _get(b));
        emit Lt(msg.sender, a, b, r);
    }

    function le(bytes32 a, bytes32 b) external returns (bytes32 r) {
        r = _bool(_get(a) <= _get(b));
        emit Le(msg.sender, a, b, r);
    }

    function gt(bytes32 a, bytes32 b) external returns (bytes32 r) {
        r = _bool(_get(a) > _get(b));
        emit Gt(msg.sender, a, b, r);
    }

    function ge(bytes32 a, bytes32 b) external returns (bytes32 r) {
        r = _bool(_get(a) >= _get(b));
        emit Ge(msg.sender, a, b, r);
    }

    function transfer(
        bytes32 balanceFrom,
        bytes32 balanceTo,
        bytes32 amount
    ) external returns (bytes32 ok, bytes32 newFrom, bytes32 newTo) {
        uint256 f = _get(balanceFrom);
        uint256 t = _get(balanceTo);
        uint256 a = _get(amount);
        bool good = f >= a;
        ok = _bool(good);
        newFrom = _uint(good ? f - a : f);
        newTo = _uint(good ? t + a : t);
        emit Transfer(msg.sender, balanceFrom, balanceTo, amount, ok, newFrom, newTo);
    }

    function mint(
        bytes32 balanceTo,
        bytes32 amount,
        bytes32 totalSupply
    ) external returns (bytes32 ok, bytes32 newTo, bytes32 newSupply) {
        uint256 t = _get(balanceTo);
        uint256 a = _get(amount);
        uint256 s = _get(totalSupply);
        unchecked {
            bool good = (t + a >= t) && (s + a >= s);
            ok = _bool(good);
            newTo = _uint(good ? t + a : t);
            newSupply = _uint(good ? s + a : s);
        }
        emit Mint(msg.sender, balanceTo, amount, totalSupply, ok, newTo, newSupply);
    }

    function burn(
        bytes32 balanceFrom,
        bytes32 amount,
        bytes32 totalSupply
    ) external returns (bytes32 ok, bytes32 newFrom, bytes32 newSupply) {
        uint256 f = _get(balanceFrom);
        uint256 a = _get(amount);
        uint256 s = _get(totalSupply);
        bool good = f >= a && s >= a;
        ok = _bool(good);
        newFrom = _uint(good ? f - a : f);
        newSupply = _uint(good ? s - a : s);
        emit Burn(msg.sender, balanceFrom, amount, totalSupply, ok, newFrom, newSupply);
    }

    // ----------------------------------------------------------------- proofs

    /// @dev Signature checking is skipped — there is no gateway locally, so
    ///      invariant I7 is NOT exercised by this mock. The ACL side effect is
    ///      modelled faithfully though: on the real system a validated input
    ///      handle becomes usable by the calling app and its owner, and without
    ///      that the first `Nox.allow` on a user-supplied handle reverts.
    function validateInputProof(
        bytes32 handle,
        address owner,
        bytes calldata,
        TEEType
    ) external {
        _admins[handle][msg.sender] = true;
        _tSet(handle, msg.sender, true);
        if (owner != address(0)) _admins[handle][owner] = true;
    }

    /// @dev Real format is `signature (65 bytes) || decryptedResult (N bytes)`.
    ///      We skip the signature and return the tail verbatim.
    function validateDecryptionProof(
        bytes32 handle,
        bytes calldata decryptionProof
    ) external view returns (bytes memory) {
        if (!(_isPublic(handle) || _publiclyDecryptable[handle])) {
            revert NotPubliclyDecryptable(handle);
        }
        if (decryptionProof.length <= 65) revert InvalidEmptyBytes();
        return decryptionProof[65:];
    }

    // ----------------------------------------------------------------- config

    function kmsPublicKey() external view returns (bytes memory) {
        return _kmsPublicKey;
    }

    function gateway() external view returns (address) {
        return _gateway;
    }

    function proofExpirationDuration() external view returns (uint256) {
        return _proofExpirationDuration;
    }

    function setKmsPublicKey(bytes calldata k) external {
        _kmsPublicKey = k;
        emit KmsPublicKeyUpdated(k);
    }

    function setGateway(address g) external {
        _gateway = g;
        emit GatewayUpdated(g);
    }

    function setProofExpirationDuration(uint256 d) external {
        _proofExpirationDuration = d;
        emit ProofExpirationDurationUpdated(d);
    }

    // ------------------------------------------------- test-only introspection

    /// @notice Read a handle's plaintext. Test harness only — the real system
    ///         has no such function, which is the entire point of Nox.
    function peek(bytes32 handle) external view returns (uint256) {
        return _values[handle];
    }

    /// @dev Set by `mintExternal`, because viem cannot read a return value from
    ///      a state-changing call.
    bytes32 public lastMinted;

    /// @notice Stand in for the Handle Gateway: mint an input handle with a known
    ///         plaintext, as `encryptInput` would produce off-chain.
    /// @dev Test-only. On the real system the caller never learns or chooses the
    ///      handle's value this way — the gateway encrypts inside the TEE.
    function mintExternal(uint256 value, TEEType teeType) external returns (bytes32 h) {
        h = _newHandle(teeType, value);
        lastMinted = h;
    }
}
