#!/usr/bin/env python3
"""Generates a synthetic CMake File API reply tree for testing without CMake installed.

Shapes follow the codemodel-v2 schema:
https://cmake.org/cmake/help/latest/manual/cmake-file-api.7.html#codemodel-version-2
"""

import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "fixture", "build")
REPLY = os.path.join(BUILD, ".cmake", "api", "v1", "reply")
SOURCE = os.path.join(HERE, "sample-project")

# name, type, source subdir, [dependency names], [external link fragments]
TARGETS = [
    ("navi_app",     "EXECUTABLE",     "app",             ["map_engine", "ui_core", "dlt_wrapper"], ["-lsqlite3", "-ldlt", "-lpthread"]),
    ("map_engine",   "STATIC_LIBRARY", "libs/map_engine", ["nds_reader", "geo_utils"], []),
    ("nds_reader",   "STATIC_LIBRARY", "libs/nds_reader", ["sqlite_wrap"], []),
    ("sqlite_wrap",  "STATIC_LIBRARY", "libs/sqlite_wrap", [], []),
    ("geo_utils",    "STATIC_LIBRARY", "libs/geo_utils",  [], []),
    ("ui_core",      "SHARED_LIBRARY", "libs/ui_core",    ["geo_utils"], ["-framework CoreGraphics"]),
    ("dlt_wrapper",  "STATIC_LIBRARY", "libs/dlt_wrapper", [], []),
    ("map_test",     "EXECUTABLE",     "tests",           ["map_engine"], ["-lgtest_main", "-lgtest"]),
    ("nds_test",     "EXECUTABLE",     "tests",           ["nds_reader"], ["-lgtest_main"]),
    ("generate_docs", "UTILITY",       ".",               [], []),
]

ON_DISK = {
    "EXECUTABLE": "{}",
    "STATIC_LIBRARY": "lib{}.a",
    "SHARED_LIBRARY": "lib{}.dylib",
}


def target_id(name):
    return "{}::@6890427a1f51a3e7e1df".format(name)


def build_target(name, kind, subdir, deps, externals):
    data = {
        "name": name,
        "id": target_id(name),
        "type": kind,
        "paths": {"source": subdir, "build": subdir},
        "sources": [{"path": "{}/{}.cpp".format(subdir, name), "isGenerated": False}],
        "dependencies": [{"id": target_id(d)} for d in deps],
    }
    if kind in ON_DISK:
        data["nameOnDisk"] = ON_DISK[kind].format(name)

    if kind in ("EXECUTABLE", "SHARED_LIBRARY", "MODULE_LIBRARY"):
        fragments = []
        # CMake lists project-built libraries on the link line too; the extension
        # must recognise those and not report them as external.
        for dep in deps:
            dep_kind = next(t[1] for t in TARGETS if t[0] == dep)
            if dep_kind in ON_DISK and dep_kind != "EXECUTABLE":
                fragments.append({
                    "fragment": "{}/{}".format(subdir, ON_DISK[dep_kind].format(dep)),
                    "role": "libraries",
                })
        for ext in externals:
            role = "frameworks" if ext.startswith("-framework") else "libraries"
            fragments.append({"fragment": ext, "role": role})
        fragments.append({"fragment": "-Wl,-dead_strip", "role": "flags"})
        data["link"] = {"language": "CXX", "commandFragments": fragments}
    elif kind == "STATIC_LIBRARY":
        data["archive"] = {}

    return data


def main():
    if os.path.isdir(os.path.join(HERE, "fixture")):
        shutil.rmtree(os.path.join(HERE, "fixture"))
    os.makedirs(REPLY)

    with open(os.path.join(BUILD, "CMakeCache.txt"), "w") as handle:
        handle.write("CMAKE_HOME_DIRECTORY:INTERNAL={}\n".format(SOURCE))

    target_files = []
    for name, kind, subdir, deps, externals in TARGETS:
        filename = "target-{}-Debug-9a1b2c3d.json".format(name)
        with open(os.path.join(REPLY, filename), "w") as handle:
            json.dump(build_target(name, kind, subdir, deps, externals), handle, indent=1)
        target_files.append({
            "name": name,
            "id": target_id(name),
            "directoryIndex": 0,
            "projectIndex": 0,
            "jsonFile": filename,
        })

    codemodel_name = "codemodel-v2-4f2a9c1e8b7d6a5c.json"
    codemodel = {
        "kind": "codemodel",
        "version": {"major": 2, "minor": 6},
        "paths": {"source": SOURCE, "build": BUILD},
        "configurations": [{
            "name": "Debug",
            "directories": [{"source": ".", "build": ".", "projectIndex": 0}],
            "projects": [{"name": "NaviDemo", "directoryIndexes": [0]}],
            "targets": target_files,
        }],
    }
    with open(os.path.join(REPLY, codemodel_name), "w") as handle:
        json.dump(codemodel, handle, indent=1)

    index = {
        "cmake": {"version": {"string": "3.28.1"}},
        "objects": [{"kind": "codemodel", "version": {"major": 2, "minor": 6}, "jsonFile": codemodel_name}],
        "reply": {
            "client-cmake-link-explorer": {
                "codemodel-v2": {
                    "kind": "codemodel",
                    "version": {"major": 2, "minor": 6},
                    "jsonFile": codemodel_name,
                }
            }
        },
    }
    with open(os.path.join(REPLY, "index-2026-09-05T00-00-00-0000.json"), "w") as handle:
        json.dump(index, handle, indent=1)

    print("fixture written to {}".format(BUILD))
    print("{} targets".format(len(TARGETS)))


if __name__ == "__main__":
    sys.exit(main())
