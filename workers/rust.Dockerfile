FROM yolomatic-worker-base:latest

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      cargo \
      rustc \
  && rm -rf /var/lib/apt/lists/*

USER yolomatic
