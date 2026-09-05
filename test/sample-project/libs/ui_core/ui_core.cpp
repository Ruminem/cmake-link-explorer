#include "ui_core.h"
#include "geo_utils.h"
namespace ui_core {
double ScreenX(double longitude) { return geo_utils::Project(0.0, longitude); }
}  // namespace ui_core
