#include "nds_reader.h"
#include "sqlite_wrap.h"
#include <vector>
namespace nds_reader {
static std::vector<int> g_tiles;
int OpenDatabase(const char* path) {
  g_tiles.assign(16, 0);
  return sqlite_wrap::Open(path);
}
}  // namespace nds_reader
