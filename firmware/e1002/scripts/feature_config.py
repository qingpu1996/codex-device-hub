from pathlib import Path
import os
import re
import sys


FEATURES = {
    "FEATURE_MEAL": {
        "default": "1",
        "disabled_src": ["meal_image_client.cpp"],
    },
    "FEATURE_WEATHER": {
        "default": "0",
        "disabled_src": ["weather_client.cpp"],
    },
}

TRUTHY = {"1", "true", "yes", "on", "enabled"}
FALSY = {"0", "false", "no", "off", "disabled"}


def normalize_feature_value(raw, name):
    value = str(raw).strip().lower()
    if value in TRUTHY:
        return "1"
    if value in FALSY:
        return "0"
    raise ValueError(f"{name} must be 0/1, true/false, yes/no, or on/off")


def read_local_features(project_dir):
    features_path = Path(project_dir) / ".local" / "features.env"
    values = {}
    if not features_path.exists():
        return values

    pattern = re.compile(r"^(FEATURE_[A-Z0-9_]+)=(.*)$")
    for line in features_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = pattern.match(line)
        if not match:
            continue
        name, value = match.groups()
        values[name] = value.strip().strip('"').strip("'")
    return values


def resolve_features(project_dir, environ=None):
    environ = environ or os.environ
    local_values = read_local_features(project_dir)
    resolved = {}

    for name, meta in FEATURES.items():
        raw = environ.get(name, local_values.get(name, meta["default"]))
        resolved[name] = normalize_feature_value(raw, name)

    return resolved


def source_filter_for(resolved):
    src_filter = ["+<*>"]
    for name, meta in FEATURES.items():
        if resolved[name] == "0":
            for source in meta.get("disabled_src", []):
                src_filter.append(f"-<{source}>")
    return src_filter


def snapshot_lines(resolved):
    return [f"{name}={value}" for name, value in sorted(resolved.items())]


def summary(resolved):
    return ", ".join(snapshot_lines(resolved))


def main(argv):
    project_dir = Path(argv[1]) if len(argv) > 1 else Path.cwd()
    command = argv[2] if len(argv) > 2 else "summary"
    resolved = resolve_features(project_dir)

    if command == "snapshot":
        print("\n".join(snapshot_lines(resolved)))
    elif command == "summary":
        print(summary(resolved))
    else:
        raise SystemExit(f"unknown feature_config command: {command}")


if __name__ == "__main__":
    main(sys.argv)
