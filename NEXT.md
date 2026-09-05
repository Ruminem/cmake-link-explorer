# NEXT

**여기까지 됨** — 후보 4번(윈도우 트리 vs 리눅스 트리 비교)을 넣었다. **160개 통과,
실패 0.** 후보 1~4를 모두 마쳤다.

**Compare With Another Build Tree** 명령이 다른 빌드 트리를 골라(감지된 목록에서
고르거나 폴더 선택) 지금 트리와 견준다. 나오는 것: 한쪽에만 있는 타겟, 그리고
공유하는 타겟의 타입·매크로·include·링크 차이.

**핵심 난점은 경로였다.** 같은 프로젝트라도 두 머신은 경로 앞부분이 완전히 다르다
(`C:/work/proj/src` vs `/home/me/proj/src`). 그대로 견주면 모든 include가 "다름"으로
나와 신호가 파묻힌다. 각 트리의 **자기 소스 루트 기준 상대 경로**로 바꿔 맞추고,
구분자를 통일하고, 대소문자는 무시한다(한쪽이 대개 윈도우고 CMake가 체크아웃과 다른
대소문자를 기록할 수 있다 — 예전에 고친 그 문제와 같은 뿌리다). 각각 테스트가 있다.

**일부러 빼는 것**: 프로젝트 밖 include 경로(`C:/SDK/include` vs `/opt/sdk/include`는
SDK 설치 위치를 말할 뿐)와 외부 라이브러리. 둘 다 매 타겟마다
걸려서 봐야 할 차이를 덮는다. (`ws2_32.lib` vs `-lz` 같은 것들이다.)

실제 검증: 같은 CMakeLists를 `-DUSE_POSIX=ON/OFF`로 두 번 configure해 붙여봤더니
`win_shim`/`posix_shim` 분기와 `core`의 `USE_IOCP`↔`USE_EPOLL`, `src/win`↔`src/posix`,
링크 대상 차이를 정확히 짚었다.

**다음 할 것** — README의 macOS 전용 명령을 윈도우와 병기한다. 네 군데다:
설치의 `ln -s` → `mklink /J`, 통합테스트의 `/Applications/...` 경로, `/tmp/it.log`,
`python3` → `python`(윈도우에서는 스토어 스텁에 걸린다). `test/bootstrap.sh`도 sh
스크립트라 윈도우에서는 `python test/make-fixture.py`를 직접 부르라는 안내가 필요하다.
컴파일러 없이 지금 바로 할 수 있는 유일하게 남은 항목이다.

**보류** — MSVC 맵 포맷과 lld 맵 포맷. 둘 다 실물 샘플부터 확보하고 시작한다.
그래프 뷰(웹뷰)는 지금 트리가 답하는 질문을 더 예쁘게 답할 뿐이라 우선순위 낮음.

**막힌 것** — 확장 호스트 35개는 VS Code 실행 경로가 macOS 전용이라 미실행.
이번 세션에 넣은 명령 넷(`compileSettings`, `projectHealth`, `compareTrees`와
backtrace 점프)은 확장 호스트 테스트가 없다 — 로직은 단위 테스트로 덮었지만
명령 등록과 출력 패널 동작은 실제로 켜봐야 안다.
**실제 회사 프로젝트에 붙여본 적이 아직 없다** — 이제 이게 압도적으로 제일 큰
미확인 항목이다. 기능을 더 붙이기보다 한 번 붙여보는 편이 낫다.
