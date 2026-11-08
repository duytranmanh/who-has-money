.DEFAULT_GOAL := help

.PHONY: help up restart down logs status

help:
	@printf '%s\n' \
	  'Usage: make <target>' \
	  '' \
	  '  help     Show available commands (default)' \
	  '  up       Build and recreate the app with current environment values' \
	  '  restart  Recreate the app without rebuilding' \
	  '  down     Stop and remove containers; keep host data' \
	  '  logs     Follow container logs (Ctrl+C to exit)' \
	  '  status   Show container status'

up:
	docker compose up -d --build --force-recreate

restart:
	docker compose up -d --force-recreate

down:
	docker compose down

logs:
	docker compose logs -f

status:
	docker compose ps
