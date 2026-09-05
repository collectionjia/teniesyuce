<script setup>
import SportsPolyBoard from './SportsPolyBoard.vue'

defineProps({
  isMember: { type: Boolean, default: false },
})
</script>

<template>
  <SportsPolyBoard api-base="/api/nba" sport-label="NBA" :is-member="isMember" />
</template>
