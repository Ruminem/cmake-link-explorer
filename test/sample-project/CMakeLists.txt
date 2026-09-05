cmake_minimum_required(VERSION 3.14)
project(NaviDemo CXX)

set(CMAKE_CXX_STANDARD 17)

add_subdirectory(libs/geo_utils)
add_subdirectory(libs/sqlite_wrap)
add_subdirectory(libs/dlt_wrapper)
add_subdirectory(libs/nds_reader)
add_subdirectory(libs/map_engine)
add_subdirectory(libs/ui_core)
add_subdirectory(app)
add_subdirectory(tests)

add_custom_target(generate_docs COMMAND ${CMAKE_COMMAND} -E echo "docs")
