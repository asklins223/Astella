import Foundation
import Security

enum KeychainTokenStore {
    private static let service = "com.astella.mobile.session"
    private static let account = "bearer-token"
    #if targetEnvironment(simulator)
    // An unsigned simulator has no Keychain entitlement. Keep that development
    // session in memory only; production credentials still require Keychain.
    private static var simulatorSession: String?
    #endif

    static func read() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else {
            #if targetEnvironment(simulator)
            return simulatorSession
            #else
            return nil
            #endif
        }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ token: String) throws {
        let data = Data(token.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let update = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert[kSecValueData as String] = data
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let addStatus = SecItemAdd(insert as CFDictionary, nil)
            guard addStatus == errSecSuccess else { try handleStorageFailure(addStatus, token: token); return }
        } else if status != errSecSuccess {
            try handleStorageFailure(status, token: token)
        }
    }

    private static func handleStorageFailure(_ status: OSStatus, token: String) throws {
        #if targetEnvironment(simulator)
        if status == errSecMissingEntitlement || status == errSecNotAvailable { simulatorSession = token; return }
        #endif
        throw TokenStoreError(status: status)
    }

    static func delete() {
        #if targetEnvironment(simulator)
        simulatorSession = nil
        #endif
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
    }
}

struct TokenStoreError: LocalizedError {
    var status: OSStatus
    var errorDescription: String? { "无法安全保存登录状态（\(status)）。" }
}
