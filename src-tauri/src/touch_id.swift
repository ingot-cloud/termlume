import CryptoKit
import Foundation
import LocalAuthentication
import Security

private let vaultKeyLength = 32

@available(macOS 10.15, *)
private struct TouchIDCredential: Codable {
    // CryptoKit exports an opaque blob that only this Secure Enclave can restore.
    let enclaveKey: Data
    let peerKey: Data
    let sealedKey: Data

    static func context(_ reason: String) -> LAContext? {
        let context = LAContext()
        context.localizedReason = reason
        context.localizedFallbackTitle = ""
        context.touchIDAuthenticationAllowableReuseDuration = 0
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil),
              context.biometryType == .touchID, SecureEnclave.isAvailable else { return nil }
        return context
    }

    static func wrappingKey(
        _ privateKey: SecureEnclave.P256.KeyAgreement.PrivateKey,
        _ peer: P256.KeyAgreement.PublicKey
    ) throws -> SymmetricKey {
        try privateKey.sharedSecretFromKeyAgreement(with: peer).hkdfDerivedSymmetricKey(
            using: SHA256.self, salt: Data(), sharedInfo: Data("termlume:touch-id:v1".utf8),
            outputByteCount: vaultKeyLength)
    }
}

@_cdecl("termlume_touch_id_available")
func touchIDAvailable() -> Bool {
    if #available(macOS 10.15, *) {
        return TouchIDCredential.context("解锁 Termlume 保险库") != nil
    }
    return false
}

@_cdecl("termlume_touch_id_enroll")
func touchIDEnroll(_ key: UnsafeRawPointer, _ output: UnsafeMutableRawPointer, _ capacity: Int) -> Int {
    guard #available(macOS 10.15, *),
          let context = TouchIDCredential.context("为 Termlume 保险库启用触控 ID"),
          let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                                                      [.privateKeyUsage, .biometryCurrentSet], nil)
    else { return 0 }
    defer { context.invalidate() }
    do {
        let privateKey = try SecureEnclave.P256.KeyAgreement.PrivateKey(
            accessControl: access, authenticationContext: context)
        let peer = P256.KeyAgreement.PrivateKey().publicKey
        // Key agreement itself requires Touch ID, including during enrollment.
        let wrappingKey = try TouchIDCredential.wrappingKey(privateKey, peer)
        let vaultKey = Data(bytesNoCopy: UnsafeMutableRawPointer(mutating: key),
                            count: vaultKeyLength, deallocator: .none)
        let sealed = try ChaChaPoly.seal(vaultKey, using: wrappingKey)
        let record = TouchIDCredential(enclaveKey: privateKey.dataRepresentation,
                                       peerKey: peer.x963Representation, sealedKey: sealed.combined)
        let bytes = try JSONEncoder().encode(record)
        guard bytes.count <= capacity else { return 0 }
        bytes.copyBytes(to: output.assumingMemoryBound(to: UInt8.self), count: bytes.count)
        return bytes.count
    } catch {
        return 0
    }
}

@_cdecl("termlume_touch_id_open")
func touchIDOpen(_ credential: UnsafeRawPointer, _ length: Int, _ output: UnsafeMutableRawPointer) -> Bool {
    guard #available(macOS 10.15, *),
          let context = TouchIDCredential.context("解锁 Termlume 保险库") else { return false }
    defer { context.invalidate() }
    do {
        let record = try JSONDecoder().decode(TouchIDCredential.self, from: Data(bytes: credential, count: length))
        let peer = try P256.KeyAgreement.PublicKey(x963Representation: record.peerKey)
        let sealed = try ChaChaPoly.SealedBox(combined: record.sealedKey)
        let privateKey = try SecureEnclave.P256.KeyAgreement.PrivateKey(
            dataRepresentation: record.enclaveKey, authenticationContext: context)
        let wrappingKey = try TouchIDCredential.wrappingKey(privateKey, peer)
        var key = try ChaChaPoly.open(sealed, using: wrappingKey)
        defer { key.resetBytes(in: key.startIndex..<key.endIndex) }
        guard key.count == vaultKeyLength else { return false }
        key.copyBytes(to: output.assumingMemoryBound(to: UInt8.self), count: key.count)
        return true
    } catch {
        return false
    }
}
