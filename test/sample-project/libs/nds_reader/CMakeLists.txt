add_library(nds_reader STATIC nds_reader.cpp)
target_include_directories(nds_reader PUBLIC .)

target_link_libraries(nds_reader PUBLIC sqlite_wrap)
