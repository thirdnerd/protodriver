-- Pure RGB565 BMP construction. No protocol or host capabilities.
local function le16(n) return string.pack("<I2", n & 0xffff) end
local function le32(n) return string.pack("<I4", n & 0xffffffff) end
local function image(pixels)
  if #pixels ~= 153600 then error("CE screen must contain 153600 octets") end
  -- The framebuffer is top-to-bottom little-endian RGB565, so the BMP uses
  -- red f800, green 07e0, and blue 001f without re-encoding the pixels.
  return table.concat({
    "BM", le32(153666), le32(0), le32(66),
    le32(40), le32(320), le32(-240),
    le16(1), le16(16), le32(3), le32(153600),
    le32(2835), le32(2835), le32(0), le32(0),
    le32(0xf800), le32(0x07e0), le32(0x001f), pixels,
  })
end
return {image=image}
