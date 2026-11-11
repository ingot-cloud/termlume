import CoreText
import Foundation

@_cdecl("termlume_terminal_fonts")
func terminalFonts(
    _ context: UnsafeMutableRawPointer,
    _ emit: @convention(c) (UnsafeMutableRawPointer, UnsafePointer<CChar>) -> Void
) {
    let families = CTFontManagerCopyAvailableFontFamilyNames() as? [String] ?? []
    let ascii = Array(UInt16(32)...UInt16(126))
    var glyphs = [CGGlyph](repeating: 0, count: ascii.count)
    var advances = [CGSize](repeating: .zero, count: ascii.count)
    for family in families {
        let font = CTFontCreateWithName(family as CFString, 12, nil)
        guard CTFontCopyFamilyName(font) as String == family,
              CTFontGetGlyphsForCharacters(font, ascii, &glyphs, ascii.count) else { continue }
        // A terminal needs printable ASCII at one cell width, regardless of the font's metadata.
        CTFontGetAdvancesForGlyphs(font, .horizontal, glyphs, &advances, glyphs.count)
        let cell = advances[0].width
        guard cell > 0, advances.allSatisfy({ abs($0.width - cell) < 0.01 }) else { continue }
        family.withCString { emit(context, $0) }
    }
}
