<script setup>
import SportsPolyBoard from './SportsPolyBoard.vue'

defineProps({
  isMember: { type: Boolean, default: false },
})
</script>

<template>
  <SportsPolyBoard api-base="/api/dota2" sport-label="DOTA2" :is-member="isMember" />
</template>
