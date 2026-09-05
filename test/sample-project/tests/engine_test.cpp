#include "engine.h"
int main() { return engine::Load("test.db") > 0.0 ? 0 : 1; }
