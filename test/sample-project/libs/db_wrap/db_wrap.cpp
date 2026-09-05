#include "db_wrap.h"
#include <string>
namespace db_wrap {
int Open(const char* path) { return path && std::string(path).size() ? 1 : 0; }
}  // namespace db_wrap
