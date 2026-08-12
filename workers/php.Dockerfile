FROM yolomatic-worker-base:latest

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      composer \
      php-cli \
      php-curl \
      php-mbstring \
  && rm -rf /var/lib/apt/lists/*

USER yolomatic
