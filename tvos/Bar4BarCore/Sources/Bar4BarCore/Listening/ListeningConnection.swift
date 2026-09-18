import Foundation
import CryptoKit
import Network

public struct ListeningInvitation: Codable, Equatable, Sendable {
  public var version = 1
  public var id: UUID
  public var service: String
  public var publicKey: Data
  public var secret: Data
  public var expires: Double
  public var url: String {
    "bar4bar-listen://pair/" + ((try? JSONEncoder().encode(self)) ?? Data()).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
  }
  public static func parse(_ value: String, now: Double = Date().timeIntervalSince1970) -> Self? {
    let prefix = "bar4bar-listen://pair/"
    guard value.hasPrefix(prefix), value.count <= 4096 else { return nil }
    let encoded = String(value.dropFirst(prefix.count)).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    guard let data = Data(base64Encoded: encoded), let result = try? JSONDecoder().decode(Self.self, from: data),
      result.version == 1, result.expires > now, result.expires <= now + 660,
      result.secret.count == 32, result.publicKey.count == 65, !result.service.isEmpty,
      result.service.count < 128 else { return nil }
    return result
  }
}

/// QR-pinned P256 ECDH plus AES-GCM, with directional sequence nonces and authenticated invitation IDs.
/// Bonjour/TCP is only the carrier; all application messages are authenticated ciphertext.
public struct ListeningCipher {
  private let key: SymmetricKey
  private let invitationID: Data
  private let outbound: Data
  private let inbound: Data
  private var sent: UInt64 = 0
  private var received: UInt64 = 0
  public init(privateKey: P256.KeyAgreement.PrivateKey, peer: Data, invitation: ListeningInvitation, server: Bool) throws {
    let shared = try privateKey.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PublicKey(x963Representation: peer))
    key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: invitation.secret,
      sharedInfo: Data(("bar4bar-listener-v1:" + invitation.id.uuidString).utf8), outputByteCount: 32)
    invitationID = Data(invitation.id.uuidString.utf8)
    outbound = Data((server ? "TV01" : "PH01").utf8)
    inbound = Data((server ? "PH01" : "TV01").utf8)
  }
  private func nonce(_ prefix: Data, _ sequence: UInt64) throws -> AES.GCM.Nonce {
    var number = sequence.bigEndian
    return try AES.GCM.Nonce(data: prefix + withUnsafeBytes(of: &number) { Data($0) })
  }
  public mutating func seal(_ value: Data) throws -> Data {
    guard sent < UInt64.max else { throw CocoaError(.coderInvalidValue) }
    let box = try AES.GCM.seal(value, using: key, nonce: nonce(outbound, sent), authenticating: invitationID)
    sent += 1
    return box.combined!
  }
  public mutating func open(_ value: Data) throws -> Data {
    guard received < UInt64.max else { throw CocoaError(.coderInvalidValue) }
    let box = try AES.GCM.SealedBox(combined: value)
    guard Data(box.nonce) == Data(try nonce(inbound, received)) else { throw CocoaError(.coderInvalidValue) }
    let plain = try AES.GCM.open(box, using: key, authenticating: invitationID)
    received += 1
    return plain
  }
}

public final class ListeningConnection: @unchecked Sendable {
  public var onMessage: (@Sendable (ListeningMessage) -> Void)?
  public var onConnected: (@Sendable () -> Void)?
  public var onDisconnected: (@Sendable () -> Void)?
  public var onInvitation: (@Sendable (ListeningInvitation) -> Void)?
  private let queue = DispatchQueue(label: "bar4bar.listening.connection")
  private var listener: NWListener?
  private var connection: NWConnection?
  private var invitation: ListeningInvitation?
  private var privateKey: P256.KeyAgreement.PrivateKey?
  private var cipher: ListeningCipher?
  private var server = false
  private var authenticated = false
  private var incoming = Data()
  private var generation = UUID()
  private var pendingBytes = 0
  private static let maximum = 16_000_000
  public init() {}

  public func host() { queue.async { [self] in
    stopInternal()
    do {
      server = true
      let key = P256.KeyAgreement.PrivateKey()
      let token = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
      let id = UUID()
      let invite = ListeningInvitation(id: id, service: "Bar4Bar-" + id.uuidString.prefix(8),
        publicKey: key.publicKey.x963Representation, secret: token, expires: Date().timeIntervalSince1970 + 600)
      privateKey = key; invitation = invite
      let value = try NWListener(using: .tcp)
      value.service = NWListener.Service(name: invite.service, type: "_bar4bar._tcp")
      value.newConnectionHandler = { [weak self] new in
        guard let self, self.connection == nil, Date().timeIntervalSince1970 < invite.expires else { new.cancel(); return }
        self.attach(new)
      }
      value.stateUpdateHandler = { [weak self] state in
        if case .ready = state { self?.onInvitation?(invite) }
        if case .failed = state { self?.stopInternal(); self?.onDisconnected?() }
      }
      listener = value; value.start(queue: queue)
    } catch { onDisconnected?() }
  }}
  public func join(_ value: ListeningInvitation) { queue.async { [self] in
    stopInternal()
    guard ListeningInvitation.parse(value.url) != nil else { onDisconnected?(); return }
    server = false; invitation = value
    do {
      let key = P256.KeyAgreement.PrivateKey(); privateKey = key
      cipher = try ListeningCipher(privateKey: key, peer: value.publicKey, invitation: value, server: false)
      attach(NWConnection(to: .service(name: value.service, type: "_bar4bar._tcp", domain: "local.", interface: nil), using: .tcp))
    } catch { onDisconnected?() }
  }}
  public func send(_ message: ListeningMessage) { queue.async { [self] in
    guard authenticated, var cipher else { return }
    do {
      let data = try cipher.seal(JSONEncoder().encode(message)); self.cipher = cipher; writeFrame(data)
    } catch { disconnect() }
  }}
  public func stop() { queue.async { [self] in stopInternal() } }
  private func attach(_ value: NWConnection) {
    connection = value; incoming.removeAll(); authenticated = false
    let epoch = UUID(); generation = epoch
    value.stateUpdateHandler = { [weak self] state in
      guard let self, self.generation == epoch else { return }
      if case .ready = state {
        if !self.server, let key = self.privateKey { self.writeFrame(key.publicKey.x963Representation) }
        self.receive(epoch)
      }
      if case .failed = state { self.disconnect() }
      if case .cancelled = state, self.connection != nil { self.disconnect() }
    }
    value.start(queue: queue)
    queue.asyncAfter(deadline: .now() + 8) { [weak self] in
      guard let self, self.generation == epoch, !self.authenticated else { return }; self.disconnect()
    }
  }
  private func receive(_ epoch: UUID) {
    connection?.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
      guard let self, self.generation == epoch else { return }
      if let data {
        self.incoming.append(data)
        guard self.incoming.count <= Self.maximum + 4 else { self.disconnect(); return }
        while self.incoming.count >= 4 {
          let count = self.incoming.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
          guard count > 0, count <= Self.maximum else { self.disconnect(); return }
          guard self.incoming.count >= Int(count) + 4 else { break }
          let frame = Data(self.incoming.dropFirst(4).prefix(Int(count)))
          self.incoming.removeFirst(Int(count) + 4)
          do { try self.consume(frame) } catch { self.disconnect(); return }
        }
      }
      if complete || error != nil { self.disconnect() } else { self.receive(epoch) }
    }
  }
  private func consume(_ frame: Data) throws {
    if server, cipher == nil {
      guard let key = privateKey, let invitation, Date().timeIntervalSince1970 < invitation.expires,
        frame.count == 65 else { throw CocoaError(.coderInvalidValue) }
      cipher = try ListeningCipher(privateKey: key, peer: frame, invitation: invitation, server: true)
      // Possession of the QR-pinned server private key is proven by the first encrypted response.
      var value = cipher!; writeFrame(try value.seal(JSONEncoder().encode(ListeningMessage.hello))); cipher = value
      return
    }
    guard var value = cipher else { throw CocoaError(.coderInvalidValue) }
    let message = try JSONDecoder().decode(ListeningMessage.self, from: value.open(frame)); cipher = value
    if !authenticated {
      guard case .hello = message else { throw CocoaError(.coderInvalidValue) }
      authenticated = true
      if !server { send(.hello) }
      onConnected?()
    } else { onMessage?(message) }
  }
  private func writeFrame(_ data: Data) {
    guard data.count <= Self.maximum, pendingBytes + data.count <= Self.maximum * 2 else { disconnect(); return }
    var count = UInt32(data.count).bigEndian
    let packet = withUnsafeBytes(of: &count) { Data($0) } + data
    pendingBytes += packet.count
    let epoch = generation
    connection?.send(content: packet, completion: .contentProcessed { [weak self] error in
      guard let self, self.generation == epoch else { return }
      self.pendingBytes -= packet.count
      if error != nil { self.disconnect() }
    })
  }
  private func disconnect() {
    generation = UUID(); connection?.cancel(); connection = nil; cipher = nil
    incoming.removeAll(); authenticated = false; pendingBytes = 0; onDisconnected?()
  }
  private func stopInternal() {
    disconnect(); listener?.cancel(); listener = nil; invitation = nil; privateKey = nil
  }
}
