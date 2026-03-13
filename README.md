# Java → Bedrock Resource Pack Converter (MortazDev)

> ⚠️ This repository is **not the main project** and is provided for
> **open-source license compliance (AGPL v3)** and reference purposes.

This project is based on **AzPixel**, which itself originated from
**java2bedrock.sh** by Kas-tle, and is distributed under the
**GNU Affero General Public License v3 (AGPL v3)**.

This repository contains the **AGPL-covered source code** maintained by
**MortazDev**, including modifications made to support specific workflows
and sound conversion.

---

## Project Status

This repository is **actively maintained** by MortazDev as a standalone
open-source converter with GitHub Actions support.

---

## Scope of This Repository

Included in this repository:
- AzPixel-based conversion scripts
- Modifications made under AGPL v3
- Core Java → Bedrock conversion logic
- Sound conversion (`sound.py`)
- GitHub Actions workflow for automated conversion

---

## Usage (Local)

### Prerequisites

Make sure the following are installed:

- `bash`
- `jq`
- `sponge` (moreutils)
- `imagemagick`
- `spritesheet-js` (via `yarn global add spritesheet-js`)
- `python3` + `Pillow` (`pip install Pillow`)

### Run

```sh
./converter.sh MyResourcePack.zip
```

With all options:

```sh
./converter.sh MyResourcePack.zip \
  -w false \
  -m null \
  -a entity_alphatest_one_sided \
  -b alpha_test \
  -f <fallback_pack_url_or_null> \
  -v 1.19.3 \
  -r false \
  -s false \
  -u true
```

| Flag | Description | Default |
|------|-------------|---------|
| `-w` | Show warning prompt | `true` |
| `-m` | Bedrock merge pack path or URL | `null` |
| `-a` | Attachable material | `entity_alphatest_one_sided` |
| `-b` | Block material | `alpha_test` |
| `-f` | Fallback/default assets URL | `null` |
| `-v` | Default assets version | `1.19.3` |
| `-r` | Rename model files | `false` |
| `-s` | Archive scratch files | `false` |
| `-u` | Disable ulimit | `false` |

---

## Usage (GitHub Actions)

Submit a conversion request by opening an issue with the **`conversion`** label
using the provided issue template. The workflow will automatically:

1. Download your Java resource pack
2. Convert it to Bedrock format
3. Upload the output as an artifact

---

## Optional Config (`mortaz_config.json`)

Place a `mortaz_config.json` inside your resource pack to control animation behavior:

```json
{
  "Animation_Selection": {
    "animation": {
      "selection": false
    },
    "skip_pack": {
      "list": {
        "your_namespace": true
      }
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `animation.selection` | `true` = disable animations (except skip_pack namespaces) |
| `skip_pack.list` | Namespaces to always include animations for |

---

## Environment Variables (manager.py)

The following env vars control which Python modules run during conversion:

| Variable | Description |
|----------|-------------|
| `SOUNDS_CONVERSION` | Convert Java sounds → Bedrock `sound_definitions.json` |
| `MEG3_FIX` | Apply ModelEngine material/transparency fix |
| `ARMOR_CONVERSION` | Convert armor textures |
| `FONT_CONVERSION` | Convert font/glyph sheets |
| `BOW_CONVERSION` | Convert bow animation models |
| `SHIELD_CONVERSION` | Convert shield models |
| `BLOCK_CONVERSION` | Convert block models |

---

## License

This project is licensed under the
**GNU Affero General Public License v3 (AGPL v3)**.

You are free to use, study, and modify this code under the terms of the AGPL v3.
A copy of the license is included in the `LICENSE` file.

---

*Maintained by MortazDev — based on AzPixel / java2bedrock.sh by Kas-tle*
