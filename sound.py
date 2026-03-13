import json, glob, os, shutil

def find_sound_file(namespace, rel):
    """Find actual .ogg path inside the pack"""
    # primary path
    p = f"pack/assets/{namespace}/sounds/{rel}.ogg"
    if os.path.exists(p):
        return p

    # fallback for minecraft vanilla (wood/stone/etc)
    parts = rel.split("/")
    if len(parts) == 2:
        cat, n = parts
        for folder in ["block", "step", "dig"]:
            guess = f"pack/assets/minecraft/sounds/{folder}/{cat}{n[-1]}.ogg"
            if os.path.exists(guess):
                return guess

    return None


def copy_sound(name):
    """Copy sound file. name can be 'minecraft:dig/wood1' or 'dig/wood1'"""
    if ":" not in name:
        name = "minecraft:" + name

    namespace, rel = name.split(":", 1)

    src = find_sound_file(namespace, rel)
    if not src:
        print("❌ Missing file:", name)
        return None

    dst = f"staging/target/rp/sounds/{rel}.ogg"
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(src, dst)
    return f"sounds/{rel}"


files = glob.glob("pack/assets/**/sounds.json")
print("Sound files:", files)

sound_defs = {
    "format_version": "1.14.0",
    "sound_definitions": {}
}

for file in files:
    namespace = file.split(os.sep)[2]
    print("Processing:", namespace)

    with open(file, "r") as f:
        data = json.load(f)

    for key, info in data.items():

        sound_id = f"{namespace}:{key}"
        sound_defs["sound_definitions"][sound_id] = {
            "category": info.get("category", "neutral"),
            "sounds": []
        }

        for s in info["sounds"]:
            if isinstance(s, dict):
                out = copy_sound(s["name"])
                if out:
                    s["name"] = out
                    sound_defs["sound_definitions"][sound_id]["sounds"].append(s)

            else:
                out = copy_sound(s)
                if out:
                    sound_defs["sound_definitions"][sound_id]["sounds"].append(out)

with open("staging/target/rp/sounds/sound_definitions.json", "w") as f:
    json.dump(sound_defs, f, indent=2)

print("✔ Sound conversion completed.")
