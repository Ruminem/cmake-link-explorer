add_library(map_engine STATIC map_engine.cpp)
target_include_directories(map_engine PUBLIC .)

target_link_libraries(map_engine PUBLIC nds_reader geo_utils)
