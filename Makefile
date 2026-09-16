.PHONY: install seed run test smoke agent-once

install:
	python -m pip install -e '.[test]'

seed:
	python -m backend.seed --reset --measurements

run:
	uvicorn backend.app.main:app --reload --port 8000

test:
	pytest
	PYTHONPATH=agent python -m unittest discover -s agent/tests -v

smoke:
	python -m compileall backend agent
	node --check web/app.js

agent-once:
	PYTHONPATH=agent python -m vko_agent --server http://127.0.0.1:8000 --once
