#include "map_engine.h"
#include "ui_core.h"
#include "dlt_wrapper.h"

int main() {
  dlt_wrapper::Log("APP", "starting");
  const double y = map_engine::Load("navi.ndsdb");
  const double x = ui_core::ScreenX(127.0);
  return (x + y) > 0.0 ? 0 : 1;
}
