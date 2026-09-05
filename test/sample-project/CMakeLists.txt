cmake_minimum_required(VERSION 3.14)
project(SampleProject CXX)

set(CMAKE_CXX_STANDARD 17)

add_subdirectory(libs/math_utils)
add_subdirectory(libs/db_wrap)
add_subdirectory(libs/log_wrapper)
add_subdirectory(libs/store_reader)
add_subdirectory(libs/engine)
add_subdirectory(libs/render_core)
add_subdirectory(app)
add_subdirectory(tests)

add_custom_target(generate_docs COMMAND ${CMAKE_COMMAND} -E echo "docs")
