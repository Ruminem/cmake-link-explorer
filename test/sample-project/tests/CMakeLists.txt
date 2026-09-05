add_executable(map_test map_test.cpp)
target_link_libraries(map_test PRIVATE map_engine)

add_executable(nds_test nds_test.cpp)
target_link_libraries(nds_test PRIVATE nds_reader)
