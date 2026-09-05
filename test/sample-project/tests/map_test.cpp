#include "map_engine.h"
int main() { return map_engine::Load("test.ndsdb") > 0.0 ? 0 : 1; }
