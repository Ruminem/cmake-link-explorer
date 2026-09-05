# NEXT

**여기까지 됨** — 윈도우에 Node 24.19.0을 깔고 `python test/make-fixture.py`로 픽스처를
만들어 테스트를 처음 돌렸다. **78개 통과, 실패 0** (File API 20, 타겟 트리 16,
맵 파서 40, include 파싱 2). 파서·트리·맵 계층은 윈도우에서 검증됐다.

**다음 할 것** — 윈도우에 `cmake`를 깔고 `test/bootstrap.sh`로 `test/sample-project/build`를
만든 뒤 `node test/include-test.js`를 완주시킨다. 경로 대소문자 수정은 윈도우를
위해 한 것인데 그걸 때리는 28개 체크가 아직 한 번도 안 돌았다 — 지금 통과한 2개는
include 문자열 파싱일 뿐이다.

**막힌 것** — `cmake`/`ninja`가 없어 sample-project 빌드 트리를 못 만든다. 그래서
include 해결 28개, 실제 CMake 트리 18개, 맵-타겟 조인 9개, 확장 호스트 35개가
전부 미실행이다. 그리고 README의 설치·통합테스트 명령이 아직 macOS 전용이라
윈도우 절차 병기가 필요하다.
