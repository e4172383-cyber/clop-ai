import XCTest
@testable import ClopIOS

final class ClopIOSTests: XCTestCase {
    func testPairingValuesMatchServerFormat() {
        let pair = PairingCrypto.make()
        XCTAssertTrue(pair.code.range(of: "^[a-f0-9]{16}$", options: .regularExpression) != nil)
        XCTAssertTrue(pair.secret.range(of: "^[A-Za-z0-9_-]{20,64}$", options: .regularExpression) != nil)
        XCTAssertTrue(pair.hash.range(of: "^[A-Za-z0-9_-]{20,64}$", options: .regularExpression) != nil)
    }

    func testProfileDecodesServerShape() throws {
        let json = #"{"ok":true,"name":"Test","plan":"GO","planKey":"go","models":[{"key":"clop4","title":"Clop 4","provider":"gpt","description":"","available":true}],"model":"clop4","efforts":[{"key":"medium","title":"Среднее"}],"effort":"medium","fast":false}"#
        let profile = try JSONDecoder().decode(UserProfile.self, from: Data(json.utf8))
        XCTAssertEqual(profile.model, "clop4")
        XCTAssertEqual(profile.models.first?.title, "Clop 4")
    }
}

